#include "greeting/greeting.h"

namespace greeting {

std::string greet(const std::string& name)
{
#ifdef NDEBUG
    const char* buildType = "Release";
#else
    const char* buildType = "Debug";
#endif
    return "Hello, " + name + "! (greeting " + buildType + " build)";
}

} // namespace greeting
