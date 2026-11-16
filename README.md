# Macbook Sift

GitHub Pages 单用户浏览器工具。机器清单读取仓库的公开 raw `listings.json`，汇率读取 Frankfurter 并按天在本机缓存。每次更新前校验整份清单。列表显示封面，详情打开时展示这台机器的图库。

喜欢、分析和删除记录保存在当前浏览器的网站数据中。可使用页底的「导出备份」和「导入备份」迁移设备。支持读取旧版 Hatch 的 v1 exportData JSON，只在本机提取用户状态。清理浏览器网站数据会移除本地记录。

使用 Bun 1.3.10 运行 `bun install --frozen-lockfile`、`bun run typecheck`、`bun test tests`、`bun run build`。构建结果在 `docs/`，将其中的文件复制到当前 Pages 发布源（此仓库为 main 根目录）。保留根目录的 `listings.json` 供 Muse 更新。

线上页面：https://bengbengbeng7.github.io/macbook-flip-calculator/
