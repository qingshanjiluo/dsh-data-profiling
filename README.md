# dsh-data-profiling

数据画像插件 — 分析 CSV/JSON 数据质量、统计摘要、缺失值与异常值检测。

## 功能特性

- **CSV 分析**：自动解析 CSV 文件，推断列类型
- **JSON 分析**：支持文件和内联 JSON 数据
- **SQL Schema 推断**：从 CREATE TABLE 语句提取字段信息
- **数据质量报告**：生成完整报告，含质量评分和问题列表
- **统计摘要**：均值、中位数、标准差、分位数
- **缺失值检测**：各列缺失比例统计
- **异常值检测**：基于 IQR 方法识别异常值
- **类型推断**：自动识别 number、date、email、boolean、string

## 安装

```bash
npm install dsh-data-profiling
```

或在 DSH 配置中添加：

```json
{
  "plugins": ["dsh-data-profiling"]
}
```

## 工具

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `profile_csv` | 分析 CSV 文件 | `file`: 文件路径, `limit?`: 行数限制 |
| `profile_json` | 分析 JSON 数据 | `file?`: 文件路径, `data?`: 内联数据 |
| `profile_sql` | 推断 SQL Schema | `schema`: CREATE TABLE 语句 |
| `profile_report` | 生成质量报告 | `file`: 文件路径（CSV 或 JSON） |

## 命令

```
/profile csv <文件>      — 分析 CSV 文件
/profile json <文件>     — 分析 JSON 文件
/profile sql <语句>      — 推断 SQL Schema
/profile report <文件>   — 生成质量报告
```

## 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用插件 |
| `sampleSize` | number | `10000` | 最大采样行数（100~100000） |
| `outlierThreshold` | number | `3` | 异常值 IQR 倍数阈值 |

## 输出示例

```json
{
  "rows": 1000,
  "columns": 5,
  "profile": {
    "age": {
      "type": "number",
      "total": 1000,
      "nonEmpty": 980,
      "missing": 20,
      "missingPct": 2,
      "unique": 65,
      "stats": {
        "mean": 35.2,
        "median": 33.0,
        "std": 12.5,
        "min": 18,
        "max": 72,
        "q1": 25,
        "q3": 45
      },
      "outliers": 3
    }
  },
  "issues": ["⚠️ email: 15% 缺失值"],
  "qualityScore": 90
}
```

## License

MIT
