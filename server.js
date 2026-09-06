const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const W = 900, H = 1600, FPS = 30;

// --- центры по координатам пользователя (кадр 900x1600) ---
const CX = 450;              // центр по горизонтали для всего
const Q_CY = 352;           // центр вопроса по вертикали
const Q_MAX_W = 560;        // макс. ширина строки вопроса (в рамке ~609 с отступами)
const ANSWER_CY = [811, 916, 1019]; // центры трёх рамок ответов

app.get('/health', (req, res) => res.json({ ok: true }));

// грубая оценка ширины строки для DejaVuSans-Bold
function textWidth(str, fontsize) {
  return str.length * fontsize * 0.56;
}

// перенос вопроса по словам + подбор размера шрифта, чтобы влезал в Q_MAX_W и <=3 строк
function wrapQuestion(text) {
  for (const fontsize of [50, 46, 42, 38, 34, 30]) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (textWidth(test, fontsize) <= Q_MAX_W) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length <= 3 && lines.every(l => textWidth(l, fontsize) <= Q_MAX_W)) {
      return { lines, fontsize };
    }
  }
  // запасной вариант: жёсткий перенос
  return { lines: [String(text || '')], fontsize: 30 };
}

function writeTmp(content) {
  const p = path.join(os.tmpdir(), 'txt_' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

app.post('/render', upload.fields([
  { name: 'fon' }, { name: 'topleft' }, { name: 'inscription' },
  { name: 'animal' }, { name: 'item' }, { name: 'transport' },
]), (req, res) => {
  const tmpFiles = [];
  try {
    const f = req.files || {};
    const get = (k) => (f[k] && f[k][0] ? f[k][0].path : null);
    const fon = get('fon');
    const layers = ['topleft', 'inscription', 'animal', 'item', 'transport'].map(get);
    if (!fon || layers.some(x => !x)) {
      return res.status(400).json({ error: 'MISSING_INPUTS' });
    }

    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); } catch (e) { payload = {}; }

    const question = payload.question || '';
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const correctPos = Number(payload.correct_answer_position) || 1; // 1-based
    const t = payload.timings || {};
    const duration = Number(t.duration || payload.duration || 10);
    const qStart = Number(t.question_start != null ? t.question_start : 2);
    const aStart = Number(t.answer_start != null ? t.answer_start : 2);
    const aStep = Number(t.answer_step != null ? t.answer_step : 0.3);
    const reveal = Number(t.reveal_start != null ? t.reveal_start : 7);

    // ---- вопрос: перенос + подбор шрифта ----
    const wrapped = wrapQuestion(question);
    const qFontsize = wrapped.fontsize;
    const qLineH = Math.round(qFontsize * 1.18);
    const qTotalH = wrapped.lines.length * qLineH;
    const qStartY = Math.round(Q_CY - qTotalH / 2);

    // ---- собрать filter_complex ----
    const parts = [];
    parts.push(`[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[bg]`);
    // накладываем 5 PNG в порядке снизу вверх
    let last = 'bg';
    for (let i = 0; i < 5; i++) {
      const inp = i + 1; // входы 1..5
      parts.push(`[${inp}:v]scale=${W}:${H}[l${i}]`);
      const out = (i === 4) ? 'ov' : `o${i}`;
      parts.push(`[${last}][l${i}]overlay=0:0:format=auto:eof_action=pass[${out}]`);
      last = out;
    }

    // цепочка drawtext
    let stream = 'ov';
    let dtIndex = 0;
    const addDraw = (opts) => {
      const outName = `d${dtIndex++}`;
      parts.push(`[${stream}]drawtext=${opts}[${outName}]`);
      stream = outName;
    };

    // строки вопроса (появляются с qStart)
    wrapped.lines.forEach((line, i) => {
      const file = writeTmp(line);
      tmpFiles.push(file);
      const y = qStartY + i * qLineH;
      addDraw(
        `fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${qFontsize}:` +
        `borderw=4:bordercolor=black@0.9:x=(w-tw)/2:y=${y}:enable='gte(t,${qStart})'`
      );
    });

    // ответы
    const aFontsize = 40;
    answers.slice(0, 3).forEach((ans, i) => {
      const file = writeTmp(String(ans));
      tmpFiles.push(file);
      const cy = ANSWER_CY[i] != null ? ANSWER_CY[i] : (811 + i * 104);
      const y = Math.round(cy - aFontsize / 2);
      const appear = aStart + aStep * i;
      const isCorrect = (i + 1) === correctPos;

      if (isCorrect) {
        // белый до reveal
        addDraw(
          `fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${aFontsize}:` +
          `borderw=4:bordercolor=black@0.9:x=(w-tw)/2:y=${y}:enable='between(t,${appear},${reveal})'`
        );
        // зелёный после reveal
        addDraw(
          `fontfile=${FONT}:textfile=${file}:fontcolor=0x28C840:fontsize=${aFontsize}:` +
          `borderw=4:bordercolor=black@0.9:x=(w-tw)/2:y=${y}:enable='gte(t,${reveal})'`
        );
      } else {
        // неправильные исчезают на reveal
        addDraw(
          `fontfile=${FONT}:textfile=${file}:fontcolor=white:fontsize=${aFontsize}:` +
          `borderw=4:bordercolor=black@0.9:x=(w-tw)/2:y=${y}:enable='between(t,${appear},${reveal})'`
        );
      }
    });

    parts.push(`[${stream}]null[vout]`);
    const filter = parts.join(';');

    const outPath = path.join(os.tmpdir(), 'render_' + Date.now() + '.mp4');
    tmpFiles.push(outPath);

    const args = [
      '-y',
      '-i', fon,
      '-loop', '1', '-i', layers[0],
      '-loop', '1', '-i', layers[1],
      '-loop', '1', '-i', layers[2],
      '-loop', '1', '-i', layers[3],
      '-loop', '1', '-i', layers[4],
      '-filter_complex', filter,
      '-map', '[vout]',
      '-map', '0:a?',
      '-t', String(duration),
      '-r', String(FPS),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '2',
      '-filter_complex_threads', '1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      outPath,
    ];

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        console.error('FFMPEG FAILED, exit code:', code);
        console.error(stderr);
        cleanup();
        return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, stderr: stderr.slice(-4000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', cleanup);
      stream.on('error', cleanup);
    });

    ff.on('error', (err) => {
      console.error('FFMPEG SPAWN ERROR:', err);
      cleanup();
      res.status(500).json({ error: 'FFMPEG_SPAWN_ERROR', message: String(err) });
    });

    function cleanup() {
      // удаляем входные файлы multer
      for (const k of Object.keys(f)) {
        for (const file of f[k]) { try { fs.unlinkSync(file.path); } catch (e) {} }
      }
      for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch (e) {} }
    }
  } catch (err) {
    console.error('HANDLER ERROR:', err);
    for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch (e) {} }
    res.status(500).json({ error: 'HANDLER_ERROR', message: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('FFmpeg render service on ' + PORT));
