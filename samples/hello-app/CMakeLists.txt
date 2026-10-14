cmake_minimum_required(VERSION 3.23)
project(hello-app LANGUAGES CXX)

find_package(greeting REQUIRED CONFIG)

add_executable(hello-app main.cpp)
target_compile_features(hello-app PRIVATE cxx_std_17)
target_link_libraries(hello-app PRIVATE greeting::greeting)
