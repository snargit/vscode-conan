cmake_minimum_required(VERSION 3.23)
project(greeting VERSION 0.1 LANGUAGES CXX)

add_library(greeting src/greeting.cpp)
target_compile_features(greeting PUBLIC cxx_std_17)
target_sources(greeting PUBLIC FILE_SET HEADERS BASE_DIRS include FILES include/greeting/greeting.h)

install(TARGETS greeting FILE_SET HEADERS)
