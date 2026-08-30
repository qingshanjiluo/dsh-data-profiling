import React, { useState, useEffect } from 'react';

interface ProfilingConfig {
  enabled: boolean;
  sampleSize: number;
  outlierThreshold: number;
}

export default function DataProfilingSettings({ config, onChange }: {
  config: ProfilingConfig;
  onChange: (config: ProfilingConfig) => void;
}) {
  const [local, setLocal] = useState<ProfilingConfig>(config);

  useEffect(() => { setLocal(config); }, [config]);

  const update = (patch: Partial<ProfilingConfig>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  };

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: 600 }}>
        数据画像配置
      </h3>

      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={local.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span>启用插件</span>
        </label>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px', color: '#666' }}>
          采样大小
        </label>
        <input
          type="number"
          min={100}
          max={100000}
          value={local.sampleSize}
          onChange={(e) => update({ sampleSize: Number(e.target.value) })}
          style={{
            width: '100%',
            padding: '8px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '14px',
          }}
        />
        <span style={{ fontSize: '12px', color: '#999' }}>100 ~ 100,000</span>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px', color: '#666' }}>
          异常值阈值（IQR 倍数）
        </label>
        <input
          type="number"
          min={1}
          max={10}
          step={0.5}
          value={local.outlierThreshold}
          onChange={(e) => update({ outlierThreshold: Number(e.target.value) })}
          style={{
            width: '100%',
            padding: '8px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '14px',
          }}
        />
        <span style={{ fontSize: '12px', color: '#999' }}>默认 3，越大越不敏感</span>
      </div>
    </div>
  );
}
