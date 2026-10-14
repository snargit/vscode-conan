#pragma once

#include <string>

namespace greeting {

// Returns a greeting for `name` that also reports how the library was built,
// so each Conan profile's build is distinguishable at run time.
std::string greet(const std::string& name);

} // namespace greeting
