# dsh-data-profiling

CSV / JSON 数据画像插件（DSH 主机工具插件）：把内联文本喂进来，得到逐列的类型推断、缺失率、
distinct、min/max 与采样值，并可再渲染成 markdown 质量报告。**纯函数实现**——不读写文件、
不联网、不起子进程，因此同样的输入永远得到同样的输出，单测完全离线。

## 工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `profile_csv` | 画像一段 CSV 文本（RFC4180 引号、内嵌逗号/换行、BOM 均可），逐列返回推断类型、缺失数与缺失率、distinct、min/max、samples | `csvText`: string, `hasHeader?`: boolean（默认 true） |
| `profile_json` | 画像 JSON 文本：对象数组、单个对象、或标量数组；列名取键的第一次出现顺序 | `jsonText`: string |
| `profile_report` | 把上面任一工具返回的 profile 原样传回，渲染 markdown 报告（汇总表 + 逐列表格 + 质量发现） | `profile`: object, `title?`: string |

列画像结构（两个画像工具共用）：

```json
{
  "ok": true, "error": "", "note": "", "source": "csv", "rows": 4,
  "columns": [
    { "name": "age", "type": "number", "total": 4, "nulls": 1, "nullPct": 25,
      "distinct": 3, "min": "25", "max": "40", "samples": ["30", "25", "40"] }
  ]
}
```

约定：

- **类型推断**：整列一致才给出 `number` / `date` / `boolean`，否则回落到 `string`（混合列）。
  `date` 接受 ISO `YYYY-MM-DD`（可选时间与时区后缀）且必须能被解析。
- **缺失值**：空串、纯空白，以及 `NA` / `N/A` / `null` / `none` / `nil` / `NaN` / `-` / `--`
  （大小写不敏感）计为 null；JSON 的 `null`、缺键同样计为 null。
- **min / max**：`number` 列按数值比较，其余按码位顺序；统一以字符串返回，全空列为 `""`。
- **samples**：按首次出现顺序取前 `sampleSize` 个去重值。
- **嵌套对象/数组**：以键排序后的紧凑 JSON 文本参与统计，保证确定性。
- 失败不抛异常：`ok: false` + `error` 说明原因（如 `invalid JSON: ...`）。

## 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sampleSize` | number | `3` | 每列返回的采样值上限 |
| `maxColumns` | number | `50` | 最多画像多少列，超出部分丢弃并在 `note` 中说明 |
| `nullWarnPct` | number | `20` | `profile_report` 报告缺失率告警阈值（百分比） |

## 安装

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-data-profiling
```

## 开发

```bash
npm install --no-audit --no-fund
npm run typecheck     # tsc --noEmit
npm run build         # lib/index.js + lib/index.d.ts
npm test              # vitest run
node scripts/load-smoke.mjs   # 校验构建产物的导出面与工具注册
```

插件遵循 Cordis 函数插件契约：导出 `name` / `inject` / `Config` / `apply`，
用 `defineTool` 注册工具（含 `output.schema` 与 `output.render`）。

本插件运行时也不依赖任何外部服务；若部署的同类插件涉及网络或命令行工具，需要通过配置注入
`fetchFn` / `runCommand` 之类的出口，而单元测试始终注入假实现，全程离线。

## License

MIT
