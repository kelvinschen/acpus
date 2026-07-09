
# TODOS

# Bugs 
1. irDigest: 全场景统一
2. CLI 结构化输出优化： 确定清楚所有可用状态
3. --json 的 inspect 需要增加 projection filter
4. 终态节点 statusReason 问题
5. database is locked: 并发是否有 lock 的问题 （是否要重构整个persistent 逻辑）



## OPT
1. skill 版本管理 加 frontmatter
2. loop ergonomic 需要大改造
3. step 的 lint： 必须用 scope 内的 step ()
4. DOs and DON'Ts
5. workflow init -> fine tuned templates (selectable)
6. provider 错误信息抛出，而不是直接写个错误 (task 也一样)
7. input 支持 repair, 支持 json file 
8. transform 函数 replace 子集问题排查，预期只是需要 expression，而不影响 replace
9. ts error hint 优化
10. fanout quorum 支持 number / Expr<number>
11. loop ergonomic

## Product
1. workflow install: install from remote: tar/zip etc , or local, to project/global
