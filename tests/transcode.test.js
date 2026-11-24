/* 转码模块纯逻辑测试：参数构建 / 命令预览 / 时长解析 / 输出命名
   describe/it/expect 由 vitest 全局注入（见 vitest.config.mjs globals:true） */
const { buildArgs, previewCommand, parseDuration, defaultOutput } = require('../lib/transcode.js');

const base = {
  input: 'C:/v/in.mp4', output: 'C:/v/out.mp4', container: 'mp4',
  vcodec: 'libx264', nvenc: false, mode: 'bitrate',
  bitrate: 2500, maxrate: 3, bufsize: 6, crf: 23,
  fps: 0, scaleMode: 'keep', audio: 'aac', abitrate: 128
};
const args = p => buildArgs({ ...base, ...p });

describe('buildArgs · 基础参数', () => {
  it('x264 目标码率 + mp4 faststart', () => {
    const a = args({});
    expect(a).toContain('-c:v'); expect(a[a.indexOf('-c:v') + 1]).toBe('libx264');
    expect(a).toContain('-b:v'); expect(a[a.indexOf('-b:v') + 1]).toBe('2500k');
    expect(a).toContain('-maxrate'); expect(a[a.indexOf('-maxrate') + 1]).toBe('3000k');
    expect(a).toContain('-bufsize'); expect(a[a.indexOf('-bufsize') + 1]).toBe('6000k');
    expect(a).toContain('-movflags'); expect(a).toContain('+faststart');
    expect(a[a.length - 1]).toBe('C:/v/out.mp4');
  });

  it('mkv 容器不加 faststart', () => {
    expect(args({ container: 'mkv' })).not.toContain('-movflags');
  });

  it('CRF 模式用 -crf，不加码率', () => {
    const a = args({ mode: 'crf', crf: 28 });
    expect(a).toContain('-crf'); expect(a[a.indexOf('-crf') + 1]).toBe('28');
    expect(a).not.toContain('-b:v');
  });

  it('帧率 >0 时加 -r，0 保持不加', () => {
    expect(args({ fps: 30 })).toContain('-r');
    expect(args({ fps: 0 })).not.toContain('-r');
  });
});

describe('buildArgs · NVENC 硬件加速', () => {
  it('libx264 映射 h264_nvenc，-cq + -b:v 0', () => {
    const a = args({ nvenc: true, mode: 'crf', crf: 24 });
    expect(a[a.indexOf('-c:v') + 1]).toBe('h264_nvenc');
    expect(a).toContain('-cq'); expect(a).toContain('-b:v');
    expect(a[a.indexOf('-b:v') + 1]).toBe('0');
    expect(a).not.toContain('-crf');
  });

  it('libx265 映射 hevc_nvenc', () => {
    const a = args({ nvenc: true, vcodec: 'libx265', mode: 'crf', crf: 28 });
    expect(a[a.indexOf('-c:v') + 1]).toBe('hevc_nvenc');
  });
});

describe('buildArgs · 缩放与时间段', () => {
  it('指定分辨率无引号（回归：引号曾导致 No such filter）', () => {
    const a = args({ scaleMode: 'size', scaleW: 1920, scaleH: 1080 });
    expect(a[a.indexOf('-vf') + 1]).toBe('scale=1920:1080');
    expect(a.join(' ')).not.toContain('"');
  });

  it('缩放百分比', () => {
    const a = args({ scaleMode: 'percent', scalePct: 50 });
    expect(a[a.indexOf('-vf') + 1]).toBe('scale=iw*0.5:ih*0.5');
  });

  it('截取段：-ss 在 -i 之前，-t 为差值（回归：-to 曾多算 ss 段）', () => {
    const a = args({ ss: 1, to: 3 });
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(a[a.indexOf('-ss') + 1]).toBe('1');
    expect(a).toContain('-t'); expect(a[a.indexOf('-t') + 1]).toBe('2');
    expect(a).not.toContain('-to');
  });

  it('to <= ss 或缺省时不截取', () => {
    expect(args({ ss: 2, to: 2 })).not.toContain('-t');
    expect(args({ ss: 5, to: 1 })).not.toContain('-t');
    expect(args({})).not.toContain('-t');
  });
});

describe('buildArgs · 音频', () => {
  it('copy 直通不加码率', () => {
    const a = args({ audio: 'copy' });
    expect(a[a.indexOf('-c:a') + 1]).toBe('copy');
    expect(a).not.toContain('-b:a');
  });

  it('ac3 指定码率', () => {
    const a = args({ audio: 'ac3', abitrate: 384 });
    expect(a[a.indexOf('-c:a') + 1]).toBe('ac3');
    expect(a[a.indexOf('-b:a') + 1]).toBe('384k');
  });
});

describe('previewCommand · 引号规则', () => {
  it('滤镜参数不加引号（回归：双重引号）', () => {
    const cmd = previewCommand({ ...base, scaleMode: 'size', scaleW: 640, scaleH: 360 });
    expect(cmd).toContain('-vf scale=640:360');
    expect(cmd).not.toContain('"\\"');
  });

  it('空格路径被引号包裹', () => {
    const cmd = previewCommand({ ...base, input: 'C:/my videos/a v.mp4' });
    expect(cmd).toContain('"C:/my videos/a v.mp4"');
  });

  it('无空格路径不加引号', () => {
    const cmd = previewCommand(base);
    expect(cmd).not.toContain('"C:/v/in.mp4"');
    expect(cmd).toContain('C:/v/in.mp4');
  });
});

describe('parseDuration · ffmpeg Duration 解析', () => {
  it('标准格式', () => {
    expect(parseDuration('  Duration: 00:01:30.50, start: 0')).toBeCloseTo(90.5);
    expect(parseDuration('Duration: 01:00:00.00')).toBe(3600);
    expect(parseDuration('Duration: 00:00:02.00')).toBe(2);
  });
  it('无 Duration 返回 0', () => {
    expect(parseDuration('no duration here')).toBe(0);
  });
});

describe('defaultOutput · 输出文件命名', () => {
  it('默认 原名.timeglass.容器（路径分隔符平台相关）', () => {
    const out = defaultOutput('C:/v/a.mp4', 'mp4');
    expect(out.endsWith('a.timeglass.mp4')).toBe(true);
    expect(out.startsWith('C:')).toBe(true);
  });
  it('非法字符清洗 + 截断 60 字符', () => {
    const out = defaultOutput('C:/v/a<b>:c?.mkv', 'mp4');
    const base = out.split(/[\\/]/).pop();
    expect(base).not.toMatch(/[<>:?]/);
    expect(base.endsWith('.timeglass.mp4')).toBe(true);
  });
});
