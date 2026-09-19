// kurobridge_core 测试基座 —— 零外部依赖的极简断言宏（不引 doctest/catch2）。
// 失败计数累加到进程级变量，main 收尾经 finish_test() 返回非零退出码（ctest 判红）。

#pragma once

#include <cstdio>
#include <sstream>
#include <string>
#include <string_view>

namespace kurobridge::testing {

inline int g_checks = 0;   // 已执行断言数
inline int g_failures = 0; // 失败断言数

// 值格式化：依赖 operator<<（测试涉及的 string/string_view/bool/整型/浮点均支持；
// bool 以 0/1 打印即可辨识）
template <typename T>
std::string describe(const T& value) {
    std::ostringstream stream;
    stream << value;
    return stream.str();
}

inline void reportFailure(const char* file, int line, const std::string& what) {
    ++g_failures;
    std::fprintf(stderr, "  FAIL %s:%d  %s\n", file, line, what.c_str());
}

}  // namespace kurobridge::testing

// 断言条件为真
#define CHECK(cond)                                                              \
    do {                                                                         \
        ++::kurobridge::testing::g_checks;                                       \
        if (!(cond)) {                                                           \
            ::kurobridge::testing::reportFailure(__FILE__, __LINE__,             \
                                                 "断言失败: " #cond);            \
        }                                                                        \
    } while (0)

// 断言两侧相等（值经 operator<< 打印辅助定位）
#define CHECK_EQ(actual, expected)                                                         \
    do {                                                                                   \
        ++::kurobridge::testing::g_checks;                                                 \
        const auto& a_ = (actual);                                                         \
        const auto& e_ = (expected);                                                       \
        if (!(a_ == e_)) {                                                                 \
            ::kurobridge::testing::reportFailure(                                          \
                __FILE__, __LINE__,                                                        \
                "相等断言失败: " #actual " == " #expected "  实际=["                       \
                + ::kurobridge::testing::describe(a_) + "]  期望=["                        \
                + ::kurobridge::testing::describe(e_) + "]");                              \
        }                                                                                  \
    } while (0)

// 收尾：打印计数并返回进程退出码（0 = 全绿）
inline int finish_test(const char* suite) {
    std::fprintf(stderr, "[%s] %d checks, %d failures\n", suite,
                 ::kurobridge::testing::g_checks, ::kurobridge::testing::g_failures);
    return ::kurobridge::testing::g_failures == 0 ? 0 : 1;
}
