const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ---------- НАСТРОЙКИ (правьте под свой дизайн) ----------
const CONFIG = {
  width: 1080,
  height: 1920,
  fps: 30,
  fontFile: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',

  // Порядок наложения PNG снизу вверх (имена = имена полей в запросе)
  pngLayers: ['topleft', 'inscription', 'animal', 'item', 'transport'],

  hook:     { fontSize: 60, y: 150,  color: 'white',   box: 'black@0.5', boxborder: 20 },
  question: { fontSize: 64, y: 380,  color: 'white',   box: 'black@0.55', boxborder: 24 },
  answers:  {
    fontSize: 56,
    yStart: 900,       // Y первого ответа
    lineHeight: 170,   // расстояние между ответами
    color: 'white',
    correctColor: '#00E676',   // зелёный для правильного после reveal
    box: 'black@0.5',
    boxborder: 20,
  },
};
// --------------------------------------------------------

const upload = multer({ dest: os.tmpdir() });

// Экранирование только пути к textfile (двоеточия в путях не бывает на linux)
function q(v) { return String(v); }

// Пишем текст во временный файл — так не нужно экранировать кавычки/апострофы в drawtext
function writeTextFile(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text == null ? '' : String(text), 'utf8');
  return p;
}

function drawtext({ textfile, fontSize, y, color, box, boxborder, enable }) {
  const parts = [
    `fontfile=${CONFIG.fontFile}`,
    `textfile=${textfile}`,
    `fontsize=${fontSize}`,
    `fontcolor=${color}`,
    `x=(w-text_w)/2`,
    `y=${y}`,
    `box=1`,
    `boxcolor=${box}`,
    `boxborderw=${boxborder}`,
    `line_spacing=8`,
  ];
  if (enable) parts.push(`enable='${enable}'`);
  return `drawtext=${parts.join(':')}`;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post(
  '/render',
  upload.fields([
    { name: 'fon', maxCount: 1 },
    { name: 'topleft', maxCount: 1 },
    { name: 'inscription', maxCount: 1 },
    { name: 'animal', maxCount: 1 },
    { name: 'item', maxCount: 1 },
    { name: 'transport', maxCount: 1 },
  ]),
  async (req, res) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    const outPath = path.join(work, 'out.mp4');
    const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} };

    try {
      const files = req.files || {};
      if (!files.fon || !files.fon[0]) {
        cleanup();
        return res.status(400).json({ error: 'MISSING_FON', detail: 'field "fon" (video) is required' });
      }

      let payload = {};
      try { payload = JSON.parse(req.body.payload || '{}'); }
      catch (e) { cleanup(); return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

      const duration   = Number(payload.duration) || 10;
      const hookStart  = Number(payload.hook_start ?? 0);
      const hookEnd    = Number(payload.hook_end ?? 2);
      const qStart     = Number(payload.question_start ?? 2);
      const aStart     = Number(payload.answers_start ?? 2);
      const aStep      = Number(payload.answer_step ?? 0.3);
      const reveal     = Number(payload.reveal_time ?? 7);

      const answers = Array.isArray(payload.answers) ? payload.answers : [];
      const correctIdx = (Number(payload.correct_answer_position) || 1) - 1;

      // ---- Собираем входы ffmpeg ----
      const inputs = ['-i', files.fon[0].path];
      const pngInputs = [];
      for (const layer of CONFIG.pngLayers) {
        if (files[layer] && files[layer][0]) {
          inputs.push('-i', files[layer][0].path);
          pngInputs.push(layer);
        }
      }

      // ---- filter_complex ----
      const fc = [];
      // База: масштаб/кроп fon до 1080x1920, фиксируем fps и длительность
      fc.push(
        `[0:v]scale=${CONFIG.width}:${CONFIG.height}:force_original_aspect_ratio=increase,` +
        `crop=${CONFIG.width}:${CONFIG.height},fps=${CONFIG.fps},trim=0:${duration},setpts=PTS-STARTPTS[base]`
      );

      // Накладываем PNG по порядку (входы 1..N)
      let last = 'base';
      pngInputs.forEach((layer, i) => {
        const inIdx = i + 1;               // 0 = fon
        const outLbl = `o${inIdx}`;
        // PNG считаем full-frame 1080x1920 → overlay 0:0. Приводим к размеру на всякий случай.
        fc.push(`[${inIdx}:v]scale=${CONFIG.width}:${CONFIG.height}[p${inIdx}]`);
        fc.push(`[${last}][p${inIdx}]overlay=0:0[${outLbl}]`);
        last = outLbl;
      });

      // ---- Тексты ----
      const draws = [];

      // Hook
      const hookFile = writeTextFile(work, 'hook.txt', payload.hook || '');
      draws.push(drawtext({
        textfile: hookFile, fontSize: CONFIG.hook.fontSize, y: CONFIG.hook.y,
        color: CONFIG.hook.color, box: CONFIG.hook.box, boxborder: CONFIG.hook.boxborder,
        enable: `between(t,${hookStart},${hookEnd})`,
      }));

      // Question (появляется на qStart и держится до конца)
      const qFile = writeTextFile(work, 'question.txt', payload.question || '');
      draws.push(drawtext({
        textfile: qFile, fontSize: CONFIG.question.fontSize, y: CONFIG.question.y,
        color: CONFIG.question.color, box: CONFIG.question.box, boxborder: CONFIG.question.boxborder,
        enable: `gte(t,${qStart})`,
      }));

      // Answers
      answers.forEach((ans, i) => {
        const appear = aStart + i * aStep;
        const y = CONFIG.answers.yStart + i * CONFIG.answers.lineHeight;
        const aFile = writeTextFile(work, `answer_${i}.txt`, ans);

        if (i === correctIdx) {
          // до reveal — обычный цвет
          draws.push(drawtext({
            textfile: aFile, fontSize: CONFIG.answers.fontSize, y,
            color: CONFIG.answers.color, box: CONFIG.answers.box, boxborder: CONFIG.answers.boxborder,
            enable: `between(t,${appear},${reveal})`,
          }));
          // после reveal — зелёный, до конца
          draws.push(drawtext({
            textfile: aFile, fontSize: CONFIG.answers.fontSize, y,
            color: CONFIG.answers.correctColor, box: CONFIG.answers.box, boxborder: CONFIG.answers.boxborder,
            enable: `gte(t,${reveal})`,
          }));
        } else {
          // неправильный — виден от появления до reveal, потом исчезает
          draws.push(drawtext({
            textfile: aFile, fontSize: CONFIG.answers.fontSize, y,
            color: CONFIG.answers.color, box: CONFIG.answers.box, boxborder: CONFIG.answers.boxborder,
            enable: `between(t,${appear},${reveal})`,
          }));
        }
      });

      fc.push(`[${last}]${draws.join(',')}[v]`);

      const args = [
        '-y',
        ...inputs,
        '-filter_complex', fc.join(';'),
        '-map', '[v]',
        '-map', '0:a?',
        '-t', String(duration),
        '-r', String(CONFIG.fps),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        outPath,
      ];

      const ff = spawn('ffmpeg', args);
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

      ff.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(outPath)) {
          cleanup();
          return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, detail: stderr.slice(-4000) });
        }
        res.setHeader('Content-Type', 'video/mp4');
        const stream = fs.createReadStream(outPath);
        stream.on('close', cleanup);
        stream.on('error', () => { cleanup(); });
        stream.pipe(res);
      });

      ff.on('error', (err) => {
        cleanup();
        res.status(500).json({ error: 'FFMPEG_SPAWN_FAILED', detail: String(err) });
      });
    } catch (err) {
      cleanup();
      res.status(500).json({ error: 'INTERNAL', detail: String(err) });
    }
  }
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`quiz-ffmpeg-service listening on ${PORT}`));
