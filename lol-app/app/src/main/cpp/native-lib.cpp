#include <jni.h>
#include <string>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <pthread.h>
#include "node.h"

// ------------------------------------------------------------------
// GCC emulated TLS 支持（__emutls_get_address）
// nodejs-mobile v18.20.4 的 arm64 libnode.so 用 GCC emutls 编译，引用了
// __emutls_get_address，但 Android bionic 不将该符号导出给 app 命名空间，
// 导致 dlopen libnode.so 时报 "cannot locate symbol"。这里提供标准实现，
// 并随 libnative-lib.so 先加载，使同一命名空间内的 libnode.so 可解析。
// 实现取自 compiler-rt 的 emutls.c（简化：不复制初始值、不执行析构）。
// ------------------------------------------------------------------
typedef struct __emutls_control {
    size_t size;
    size_t align;
    union { uintptr_t index; void *address; } object;
    void (*dtor)(void *);
} __emutls_control;

static pthread_key_t emutls_key;
static pthread_once_t emutls_once = PTHREAD_ONCE_INIT;

static void emutls_init(void) {
    pthread_key_create(&emutls_key, NULL);
}

extern "C" void *__emutls_get_address(__emutls_control *control) {
    pthread_once(&emutls_once, emutls_init);
    void **slot = (void **)pthread_getspecific(emutls_key);
    if (slot == NULL) {
        slot = (void **)calloc(1, sizeof(void *));
        if (!slot) return NULL;
        pthread_setspecific(emutls_key, slot);
    }
    void *object = *slot;
    if (object == NULL) {
        if (control->align) {
            if (posix_memalign(&object, control->align, control->size ? control->size : 1) != 0)
                return NULL;
        } else {
            object = malloc(control->size ? control->size : 1);
            if (!object) return NULL;
        }
        *slot = object;
    }
    return object;
}

extern "C" void __emutls_unregister_key(void) {
    // 无需清理（进程生命周期内保持）
}

// node 的 libuv 要求所有参数存放在连续内存中。
// 接收 Java String[]（argv），转成 libuv 友好格式后调用 node::Start。
extern "C" jint JNICALL
Java_com_lplsched_app_MainActivity_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {

    // Android 16 (API 36) 上，nodejs-mobile 预编译二进制初始化 V8 时
    // WebAssembly trap handler 与新版系统交互导致 SIGSEGV。
    // 尝试通过 NODE_OPTIONS 关闭 wasm trap handler / 相关优化规避。
    setenv("NODE_OPTIONS", "--no-wasm-trap-handler", 1);

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
    free(args_buffer);

    return jint(node_result);
}
