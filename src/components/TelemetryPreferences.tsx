import { ShieldCheck, X } from "lucide-react";
import type { TelemetryPreferences as Preferences } from "../types/telemetry";

interface TelemetryPreferencesProps {
  mode: "consent" | "settings";
  preferences: Preferences;
  busy: boolean;
  onChange: (enabled: boolean) => void;
  onClose?: () => void;
}

export function TelemetryPreferences({ mode, preferences, busy, onChange, onClose }: TelemetryPreferencesProps) {
  const consent = mode === "consent";
  return <div className="privacy-backdrop" role="presentation">
    <section className={`privacy-dialog ${consent ? "consent" : "settings"}`} role="dialog" aria-modal="true" aria-labelledby="privacy-title">
      <header className="privacy-heading">
        <span className="privacy-symbol"><ShieldCheck size={20} /></span>
        <div>
          <small>{consent ? "首次使用设置" : "设置 / 隐私"}</small>
          <h2 id="privacy-title">{consent ? "帮助改进 OOOSplat" : "隐私"}</h2>
        </div>
        {!consent && <button className="privacy-close" type="button" aria-label="关闭隐私设置" disabled={busy} onClick={onClose}><X size={18} /></button>}
      </header>

      {consent ? <>
        <p className="privacy-intro">分享匿名的使用与性能统计，帮助我们改善 OOOSplat 的稳定性和处理体验。是否参与完全由你决定，之后也可以随时关闭。</p>
        <div className="privacy-columns">
          <div><strong>可能收集</strong><ul><li>应用版本、操作系统和 CPU 架构</li><li>随机匿名安装 ID</li><li>生成成功或失败及安全错误码</li><li>质量档位和流水线阶段耗时</li></ul></div>
          <div className="never"><strong>绝不收集</strong><ul><li>视频、图片或高斯泼溅文件</li><li>文件名、路径和项目名称</li><li>项目内容、日志和命令输出</li><li>用户名或任何个人信息</li></ul></div>
        </div>
        <p className="privacy-footnote">每台设备只生成一个完全随机的 UUID，不读取硬件序列号、MAC 地址或设备指纹。</p>
        {preferences.deliveryStatus === "notConfigured" && <p className="privacy-delivery-note">当前构建尚未配置统计接收端点，因此不会产生遥测网络请求。</p>}
        {preferences.deliveryStatus === "debug" && <p className="privacy-delivery-note">当前为遥测调试模式：仅在本机输出脱敏 JSON，不发送网络请求。</p>}
        <div className="privacy-actions">
          <button className="privacy-secondary" type="button" disabled={busy} onClick={() => onChange(false)}>不用了</button>
          <button className="privacy-primary" type="button" disabled={busy} onClick={() => onChange(true)}>{busy ? "正在保存…" : "分享匿名统计"}</button>
        </div>
      </> : <>
        <div className="privacy-setting-row">
          <div><strong>匿名使用统计</strong><p>分享匿名的使用与性能数据，帮助改进 OOOSplat。不会收集任何素材、文件路径或个人信息。</p></div>
          <button
            type="button"
            role="switch"
            aria-checked={preferences.analyticsEnabled}
            aria-label="匿名使用统计"
            className={preferences.analyticsEnabled ? "privacy-switch enabled" : "privacy-switch"}
            disabled={busy}
            onClick={() => onChange(!preferences.analyticsEnabled)}
          ><span /></button>
        </div>
        <div className="privacy-summary">
          <p><b>收集：</b>版本、系统、架构、匿名安装 ID、生成结果和阶段耗时。</p>
          <p><b>不收集：</b>视频、图片、高斯文件、文件名、路径、项目内容和个人信息。</p>
          {preferences.deliveryStatus === "notConfigured" && <p><b>网络状态：</b>此构建未配置统计端点，不会发送请求。</p>}
          {preferences.deliveryStatus === "debug" && <p><b>网络状态：</b>调试模式，仅输出脱敏 JSON。</p>}
        </div>
      </>}
    </section>
  </div>;
}
