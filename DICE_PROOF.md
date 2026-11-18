# 真实骰子核验

时间：2026-11-18T19:46:42.276Z。Chrome browser Web Crypto + real IndexedDB。

- LLM调用：0。
- 六个D20原骰：5、5、19、6、1、13；合计49。
- 首次随机数调用：6次。
- 同ID重试后随机数调用：6次。
- 已存记录读回一致：true。
- 重试复用原结果：true。
- 改变已投参数被拒绝：true。

正式实现：src/exact.js的randomDie/sampleDice、src/game-db.js的GameDatabase.roll。LLM只能请求参数，不提供骰点。
