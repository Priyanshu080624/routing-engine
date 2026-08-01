cmake_minimum_required(VERSION 3.10)
# Name of your project
project(TrafficEngine)

# Use modern C++
set(CMAKE_CXX_STANDARD 17)

# Tell CMake to find the libraries you downloaded via vcpkg
find_package(CURL REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

# Create the executable from your main.cpp file
add_executable(traffic_engine main.cpp)

# Link the libraries to your executable
target_link_libraries(traffic_engine PRIVATE CURL::libcurl nlohmann_json::nlohmann_json)