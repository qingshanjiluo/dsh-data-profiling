/**
 * dsh-data-profiling — 数据画像
 *
 * 功能：
 * 1. 分析 CSV/JSON 数据质量
 * 2. 统计摘要（均值/中位数/标准差）
 * 3. 缺失值检测
 * 4. 异常值检测
 * 5. 数据类型推断
 *
 * 工具：profile_csv, profile_json, profile_sql, profile_report
 * 命令：/profile
 * 配置：enabled, sampleSize
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { z } from 'zod';

export const name = 'dsh-data-profiling';
export const inject = ['settings', 'tools', 'commands'];

const configSchema = z.object({
  enabled: z.boolean().default(true),
  sampleSize: z.number().int().min(100).max(100000).default(10000),
  outlierThreshold: z.number().default(3),
});

type Config = z.infer<typeof configSchema>;

function parseCSV(content: string): Record<string, any>[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: Record<string, any> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function inferType(values: any[]): string {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'empty';
  if (nonEmpty.every(v => !isNaN(Number(v)))) return 'number';
  if (nonEmpty.every(v => /^\d{4}-\d{2}-\d{2}/.test(String(v)))) return 'date';
  if (nonEmpty.every(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)))) return 'email';
  if (nonEmpty.every(v => typeof v === 'boolean' || v === 'true' || v === 'false')) return 'boolean';
  return 'string';
}

function calcStats(values: number[]): { mean: number; median: number; std: number; min: number; max: number; q1: number; q3: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  return {
    mean: Math.round(mean * 100) / 100,
    median: Math.round(median * 100) / 100,
    std: Math.round(Math.sqrt(variance) * 100) / 100,
    min: sorted[0],
    max: sorted[n - 1],
    q1: sorted[Math.floor(n * 0.25)],
    q3: sorted[Math.floor(n * 0.75)],
  };
}

function detectOutliers(values: number[], threshold: number): number[] {
  const stats = calcStats(values);
  const iqr = stats.q3 - stats.q1;
  return values.filter(v => v < stats.q1 - threshold * iqr || v > stats.q3 + threshold * iqr);
}

function profile(data: Record<string, any>[], config: Config): any {
  if (data.length === 0) return { error: '无数据' };
  const columns = Object.keys(data[0]);
  const profileResult: Record<string, any> = {};

  for (const col of columns) {
    const values = data.map(r => r[col]);
    const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
    const type = inferType(values);
    const colProfile: any = {
      type,
      total: values.length,
      nonEmpty: nonEmpty.length,
      missing: values.length - nonEmpty.length,
      missingPct: Math.round((1 - nonEmpty.length / values.length) * 100),
      unique: new Set(nonEmpty).size,
    };

    if (type === 'number') {
      const nums = nonEmpty.map(Number);
      colProfile.stats = calcStats(nums);
      colProfile.outliers = detectOutliers(nums, config.outlierThreshold).length;
    } else {
      const freq: Record<string, number> = {};
      for (const v of nonEmpty) { freq[String(v)] = (freq[String(v)] || 0) + 1; }
      colProfile.topValues = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
    }

    profileResult[col] = colProfile;
  }

  return { rows: data.length, columns: columns.length, profile: profileResult };
}

export function apply(ctx: any, config: Config) {
  if (!config.enabled) return;

  ctx.tools.register({
    name: 'profile_csv',
    description: '分析 CSV 文件，返回各列类型、缺失值、统计摘要和异常值',
    parameters: z.object({ file: z.string(), limit: z.number().optional() }),
    async execute({ file, limit }: any) {
      const filePath = resolve(file);
      if (!existsSync(filePath)) return { error: `文件不存在: ${file}` };
      const content = readFileSync(filePath, 'utf-8');
      let data = parseCSV(content);
      if (limit) data = data.slice(0, limit);
      return profile(data, config);
    },
  });

  ctx.tools.register({
    name: 'profile_json',
    description: '分析 JSON 数据（文件或内联），返回数据质量报告',
    parameters: z.object({ file: z.string().optional(), data: z.any().optional() }),
    async execute({ file, data }: any) {
      if (file) {
        const filePath = resolve(file);
        if (!existsSync(filePath)) return { error: `文件不存在: ${file}` };
        data = JSON.parse(readFileSync(filePath, 'utf-8'));
      }
      if (!Array.isArray(data)) data = [data];
      return profile(data, config);
    },
  });

  ctx.tools.register({
    name: 'profile_sql',
    description: '从 SQL CREATE TABLE 语句推断字段 Schema',
    parameters: z.object({ schema: z.string() }),
    async execute({ schema }: any) {
      const fields = schema.matchAll(/^\s+(\w+)\s+(\w+)/gm);
      const columns: Record<string, any> = {};
      for (const match of fields) {
        const name = match[1];
        if (['PRIMARY', 'UNIQUE', 'INDEX', 'CONSTRAINT', 'KEY'].includes(name.toUpperCase())) continue;
        columns[name] = { type: match[2], inferred: inferType([match[2]]) };
      }
      return { columns: Object.keys(columns).length, schema: columns };
    },
  });

  ctx.tools.register({
    name: 'profile_report',
    description: '生成完整数据质量报告，含问题列表和质量评分',
    parameters: z.object({ file: z.string() }),
    async execute({ file }: any) {
      const filePath = resolve(file);
      if (!existsSync(filePath)) return { error: `文件不存在: ${file}` };
      const content = readFileSync(filePath, 'utf-8');
      const ext = extname(file);
      let data: Record<string, any>[] = [];
      if (ext === '.csv') data = parseCSV(content);
      else if (ext === '.json') {
        const parsed = JSON.parse(content);
        data = Array.isArray(parsed) ? parsed : [parsed];
      }

      const result = profile(data, config);
      const issues: string[] = [];
      for (const [col, p] of Object.entries(result.profile as any)) {
        if (p.missingPct > 20) issues.push(`⚠️ ${col}: ${p.missingPct}% 缺失值`);
        if (p.outliers > 0) issues.push(`⚠️ ${col}: ${p.outliers} 个异常值`);
        if (p.unique === 1) issues.push(`⚠️ ${col}: 常量列`);
      }
      return { ...result, issues, qualityScore: Math.max(0, 100 - issues.length * 10) };
    },
  });

  ctx.commands.register({
    name: 'profile',
    description: '数据画像命令',
    async execute(args: string) {
      return { content: '用法: /profile csv|json|sql|report <文件>' };
    },
  });

  ctx.settings.register({ title: 'data-profiling', description: '数据画像', config: configSchema });
}
