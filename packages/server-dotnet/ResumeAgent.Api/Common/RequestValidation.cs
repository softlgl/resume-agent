// 请求体校验规则。Node 侧用 zod schema 声明式地写一次，这里改成手写 if 后，
// 同一条规则容易被在多个端点里各抄一遍（注册与登录的用户名/密码长度就曾各抄一次）。
// 所以把「跨端点复用」的规则集中到这里。
//
// 只收多字段规则：像 resumeId 非空这种单字段检查散在十几个端点里，抽出来只增加跳转成本。
// 注意别把「可空字段 + 存在性校验」的规则也搬进来——那样调用方拿不到编译器的 null 流信息，
// 反而会在每个端点新增 CS8601/CS8602。要真正声明式地校验请求体得上验证库，不在本次范围内。

namespace ResumeAgent.Api.Common;

internal static class RequestValidation
{
    /// <summary>用户名 3-32 位、密码 6-64 位。注册与登录共用一条规则。</summary>
    public static bool IsValidCredentials(string username, string password) =>
        username.Length is >= 3 and <= 32 && password.Length is >= 6 and <= 64;
}