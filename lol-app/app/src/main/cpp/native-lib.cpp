#include <jni.h>
#include <string>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <pthread.h>
#include <android/log.h>
#include "node.h"

#define LOGNW(...) __android_log_print(ANDROID_LOG_INFO, "nodewrap", __VA_ARGS__)

// ==================================================================
// GCC emulated TLS 支持 —— 完整实现（取自 compiler-rt 的 emutls.c）
//
// nodejs-mobile v18.20.4 的 arm64 libnode.so 用 GCC emutls 编译，
// 未定义 __emutls_get_address（Android bionic 不导出给 app 命名空间），
// 导致 dlopen libnode.so 时报 "cannot locate symbol"。同时，V8 使用大量
// TLS 变量，必须按每个 __emutls_control 的 index 各自管理 slot（含初始值
// 复制），否则 TLS 变量互相覆盖会在 V8 初始化时 SIGSEGV。
// 此处提供 compiler-rt 的权威实现，并随 libnative-lib.so 先加载，
// 使同一命名空间内的 libnode.so 可解析。
// ==================================================================
#define __STDC_FORMAT_MACROS
#include <cstdio>

typedef struct emutls_address_array {
  uintptr_t skip_destructor_rounds;
  uintptr_t size; // number of elements in the 'data' array
  void *data[];
} emutls_address_array;

static pthread_mutex_t emutls_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_key_t emutls_pthread_key;
static bool emutls_key_created = false;

typedef unsigned int gcc_word __attribute__((mode(word)));
typedef unsigned int gcc_pointer __attribute__((mode(pointer)));

static void emutls_shutdown(emutls_address_array *array);

static void *emutls_memalign_alloc(size_t align, size_t size) {
#define EXTRA_ALIGN_PTR_BYTES (align - 1 + sizeof(void *))
  char *object;
  if ((object = (char *)malloc(EXTRA_ALIGN_PTR_BYTES + size)) == NULL)
    abort();
  void *base = (void *)(((uintptr_t)(object + EXTRA_ALIGN_PTR_BYTES)) &
                        ~(uintptr_t)(align - 1));
  ((void **)base)[-1] = object;
  return base;
}

static void emutls_memalign_free(void *base) {
  free(((void **)base)[-1]);
}

static void emutls_setspecific(emutls_address_array *value) {
  pthread_setspecific(emutls_pthread_key, (void *)value);
}

static emutls_address_array *emutls_getspecific(void) {
  return (emutls_address_array *)pthread_getspecific(emutls_pthread_key);
}

// Bionic 有 4 轮 pthread key 清理；延迟到第 2 轮释放
#define EMUTLS_SKIP_DESTRUCTOR_ROUNDS 1

static void emutls_key_destructor(void *ptr) {
  emutls_address_array *array = (emutls_address_array *)ptr;
  if (array->skip_destructor_rounds > 0) {
    array->skip_destructor_rounds--;
    emutls_setspecific(array);
  } else {
    emutls_shutdown(array);
    free(ptr);
  }
}

static void emutls_init(void) {
  if (pthread_key_create(&emutls_pthread_key, emutls_key_destructor) != 0)
    abort();
  emutls_key_created = true;
}

static void emutls_init_once(void) {
  static pthread_once_t once = PTHREAD_ONCE_INIT;
  pthread_once(&once, emutls_init);
}

static void emutls_lock(void) { pthread_mutex_lock(&emutls_mutex); }
static void emutls_unlock(void) { pthread_mutex_unlock(&emutls_mutex); }

static size_t emutls_num_object = 0; // number of allocated TLS objects

// Free the allocated TLS data
static void emutls_shutdown(emutls_address_array *array) {
  if (array) {
    uintptr_t i;
    for (i = 0; i < array->size; ++i) {
      if (array->data[i])
        emutls_memalign_free(array->data[i]);
    }
  }
}

// For every TLS variable xyz,
// there is one __emutls_control variable named __emutls_v.xyz.
// If xyz has non-zero initial value, __emutls_v.xyz's "value"
// will point to __emutls_t.xyz, which has the initial value.
typedef struct __emutls_control {
  gcc_word size;  // size of the object in bytes
  gcc_word align; // alignment of the object in bytes
  union {
    uintptr_t index; // data[index-1] is the object address
    void *address;   // object address, when in single thread env
  } object;
  void *value; // null or non-zero initial value for the object
} __emutls_control;

// Emulated TLS objects are always allocated at run-time.
static void *emutls_allocate_object(__emutls_control *control) {
  size_t size = control->size;
  size_t align = control->align;
  if (align < sizeof(void *))
    align = sizeof(void *);
  if ((align & (align - 1)) != 0)
    abort();

  void *base = emutls_memalign_alloc(align, size);
  if (control->value)
    memcpy(base, control->value, size);
  else
    memset(base, 0, size);
  return base;
}

static uintptr_t emutls_get_index(__emutls_control *control) {
  uintptr_t index = __atomic_load_n(&control->object.index, __ATOMIC_ACQUIRE);
  if (!index) {
    emutls_init_once();
    emutls_lock();
    index = control->object.index;
    if (!index) {
      index = ++emutls_num_object;
      __atomic_store_n(&control->object.index, index, __ATOMIC_RELEASE);
    }
    emutls_unlock();
  }
  return index;
}

static void emutls_check_array_set_size(emutls_address_array *array,
                                        uintptr_t size) {
  if (array == NULL)
    abort();
  array->size = size;
  emutls_setspecific(array);
}

static uintptr_t emutls_new_data_array_size(uintptr_t index) {
  uintptr_t header_words = sizeof(emutls_address_array) / sizeof(void *);
  return ((index + header_words + 15) & ~((uintptr_t)15)) - header_words;
}

static uintptr_t emutls_asize(uintptr_t N) {
  return N * sizeof(void *) + sizeof(emutls_address_array);
}

static emutls_address_array *emutls_get_address_array(uintptr_t index) {
  emutls_address_array *array = emutls_getspecific();
  if (array == NULL) {
    uintptr_t new_size = emutls_new_data_array_size(index);
    array = (emutls_address_array *)malloc(emutls_asize(new_size));
    if (array) {
      memset(array->data, 0, new_size * sizeof(void *));
      array->skip_destructor_rounds = EMUTLS_SKIP_DESTRUCTOR_ROUNDS;
    }
    emutls_check_array_set_size(array, new_size);
  } else if (index > array->size) {
    uintptr_t orig_size = array->size;
    uintptr_t new_size = emutls_new_data_array_size(index);
    array = (emutls_address_array *)realloc(array, emutls_asize(new_size));
    if (array)
      memset(array->data + orig_size, 0,
             (new_size - orig_size) * sizeof(void *));
    emutls_check_array_set_size(array, new_size);
  }
  return array;
}

extern "C" __attribute__((visibility("default")))
void *__emutls_get_address(__emutls_control *control) {
  uintptr_t index = emutls_get_index(control);
  emutls_address_array *array = emutls_get_address_array(index--);
  if (array->data[index] == NULL)
    array->data[index] = emutls_allocate_object(control);
  return array->data[index];
}

// Called by Bionic on dlclose to delete the emutls pthread key.
__attribute__((visibility("hidden"))) void __emutls_unregister_key(void) {
  if (emutls_key_created) {
    pthread_key_delete(emutls_pthread_key);
    emutls_key_created = false;
  }
}

// ==================================================================
// node 启动桥（JNI）
// ==================================================================
// node 的 libuv 要求所有参数存放在连续内存中。
// 接收 Java String[]（argv），转成 libuv 友好格式后调用 node::Start。
extern "C" jint JNICALL
Java_com_lplsched_app_MainActivity_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {

    LOGNW("startNodeWithArguments called");
    setenv("NODE_OPTIONS", "", 1);

    jsize argument_count = env->GetArrayLength(arguments);

    // 计算所有参数连续内存所需字节数
    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        jstring argString = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *arg = env->GetStringUTFChars(argString, 0);
        c_arguments_size += (int) strlen(arg);
        c_arguments_size++; // 结尾 '\0'
        env->ReleaseStringUTFChars(argString, arg);
    }

    char *args_buffer = (char *) calloc(c_arguments_size, sizeof(char));
    char *argv[argument_count];
    char *current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        jstring argString = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *current_argument = env->GetStringUTFChars(argString, 0);

        strcpy(current_args_position, current_argument);
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;

        env->ReleaseStringUTFChars(argString, current_argument);
    }

    int node_result = node::Start(argument_count, argv);
    LOGNW("node::Start returned: %d", node_result);
    free(args_buffer);

    return jint(node_result);
}
