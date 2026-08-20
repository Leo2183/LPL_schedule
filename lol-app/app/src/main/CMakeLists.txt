cmake_minimum_required(VERSION 3.18.1)
project("lolnode")

# node 的头文件
include_directories(libnode/include/node/)

# 导入预编译的 libnode
add_library( libnode SHARED IMPORTED )
set_target_properties( libnode PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so )

# 启动 node 的 JNI 桥
add_library( native-lib SHARED
        cpp/native-lib.cpp )

target_link_libraries( native-lib
        libnode
        log )
