const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const compression = require('compression');
const crypto = require('crypto');

const app = express();
const PORT = 3004;
const JWT_SECRET = 'kboom-secret-2026';

app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'www'), { maxAge: '1h' }));

const db = new sqlite3.Database('./kboom.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0,
    last_pop_date TEXT,
    char_hat TEXT DEFAULT 'none',
    char_eyes TEXT DEFAULT 'normal',
    char_outfit TEXT DEFAULT 'default',
    char_bg TEXT DEFAULT 'blue',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS daily_pops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    balloon_index INTEGER NOT NULL,
    balloon_type TEXT NOT NULL,
    points_earned INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS owned_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    UNIQUE(user_id, item_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    reward INTEGER NOT NULL,
    UNIQUE(user_id, date)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS mission_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    mission_key TEXT NOT NULL,
    reward INTEGER NOT NULL,
    UNIQUE(user_id, date, mission_key)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(from_user_id, to_user_id, date)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT UNIQUE NOT NULL,
    used_by INTEGER,
    used_at DATETIME
  )`);
  // migrations
  db.run(`ALTER TABLE users ADD COLUMN total_pops INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN best_streak INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN char_skin TEXT DEFAULT 'chibi'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN invite_code TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN char_frame TEXT DEFAULT 'none'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN char_card_style TEXT DEFAULT 'none'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN best_arcade_stage INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN email TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN weekly_points INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN week_str TEXT`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
  // generate invite codes for users that don't have one
  db.all(`SELECT id FROM users WHERE invite_code IS NULL`, [], (err, rows) => {
    if (rows) rows.forEach(r => {
      const code = r.id.toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
      db.run(`UPDATE users SET invite_code=? WHERE id=?`, [code, r.id], () => {});
    });
  });
});

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Neautorizat' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Token invalid' }); }
}

const BALLOON_TYPES = ['red','green','blue','orange','purple','pink','gold','rainbow'];
const POINTS = { red:10, green:12, blue:15, orange:20, purple:25, pink:30, gold:50, rainbow:100 };

function getWeekStr() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function seededRand(seed, max) {
  const x = Math.sin(seed + 1) * 10000;
  return Math.floor((x - Math.floor(x)) * max);
}

function getTodayBalloons(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const seed = userId * 31 + parseInt(today.replace(/-/g, '')) % 9999;
  return [
    BALLOON_TYPES[seededRand(seed * 1, BALLOON_TYPES.length)],
    BALLOON_TYPES[seededRand(seed * 2, BALLOON_TYPES.length)],
    BALLOON_TYPES[seededRand(seed * 3, BALLOON_TYPES.length)]
  ];
}

// ─── MISSIONS ───────────────────────────────────────────────────────────────
const ALL_MISSIONS = [
  { key:'pop_gold',    label:'Sparge un balon 🏅 Auriu',        reward:30, emoji:'🏅' },
  { key:'pop_rainbow', label:'Sparge un balon 🌈 Curcubeu',     reward:50, emoji:'🌈' },
  { key:'pop_all',     label:'Sparge toate 3 baloanele',         reward:25, emoji:'💥' },
  { key:'pop_purple',  label:'Sparge un balon 💜 Mov',          reward:15, emoji:'💜' },
  { key:'pop_pink',    label:'Sparge un balon 🩷 Roz',          reward:15, emoji:'🩷' },
  { key:'pop_2diff',   label:'Sparge 2 tipuri diferite',         reward:20, emoji:'🎯' },
  { key:'streak_keep', label:'Mentine streak-ul activ',          reward:20, emoji:'🔥' },
  { key:'pop_3today',  label:'Sparge 3 baloane azi',             reward:25, emoji:'🎈' },
];

function getTodayMissions(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const seed = userId * 17 + parseInt(today.replace(/-/g, '')) % 7777;
  const idxs = new Set();
  let s = seed;
  while (idxs.size < 3) { s = (s * 1103515245 + 12345) & 0x7fffffff; idxs.add(s % ALL_MISSIONS.length); }
  return [...idxs].map(i => ALL_MISSIONS[i]);
}

function checkMission(key, pops, streak) {
  const types = pops.map(p => p.balloon_type);
  switch(key) {
    case 'pop_gold':    return types.includes('gold');
    case 'pop_rainbow': return types.includes('rainbow');
    case 'pop_all':     return pops.length >= 3;
    case 'pop_3today':  return pops.length >= 3;
    case 'pop_purple':  return types.includes('purple');
    case 'pop_pink':    return types.includes('pink');
    case 'pop_2diff':   return new Set(types).size >= 2;
    case 'streak_keep': return (streak || 0) >= 1;
    default: return false;
  }
}

app.get('/api/missions', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const missions = getTodayMissions(req.user.id);
  db.all('SELECT * FROM daily_pops WHERE user_id=? AND date=?', [req.user.id, today], (err, pops) => {
    db.get('SELECT streak FROM users WHERE id=?', [req.user.id], (err, u) => {
      db.all('SELECT mission_key FROM mission_claims WHERE user_id=? AND date=?', [req.user.id, today], (err, claimed) => {
        const claimedKeys = (claimed||[]).map(c => c.mission_key);
        res.json(missions.map(m => ({
          ...m,
          done: checkMission(m.key, pops||[], u?.streak||0),
          claimed: claimedKeys.includes(m.key)
        })));
      });
    });
  });
});

app.post('/api/missions/claim', auth, (req, res) => {
  const { mission_key } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const missions = getTodayMissions(req.user.id);
  const mission = missions.find(m => m.key === mission_key);
  if (!mission) return res.status(400).json({ error: 'Misiune inexistenta' });
  db.all('SELECT * FROM daily_pops WHERE user_id=? AND date=?', [req.user.id, today], (err, pops) => {
    db.get('SELECT streak FROM users WHERE id=?', [req.user.id], (err, u) => {
      if (!checkMission(mission_key, pops||[], u?.streak||0))
        return res.status(400).json({ error: 'Misiune neindeplinita' });
      db.run('INSERT OR IGNORE INTO mission_claims (user_id,date,mission_key,reward) VALUES (?,?,?,?)',
        [req.user.id, today, mission_key, mission.reward], function(err) {
        if (this.changes === 0) return res.status(400).json({ error: 'Deja revendicata' });
        db.run('UPDATE users SET points=points+? WHERE id=?', [mission.reward, req.user.id], () => {
          db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, user) => {
            res.json({ success: true, reward: mission.reward, total_points: user.points });
          });
        });
      });
    });
  });
});

// ─── SPIN WHEEL ─────────────────────────────────────────────────────────────
const SPIN_PRIZES = [5,5,5,10,10,10,15,20,25,30,50,100];

app.get('/api/spin', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  db.get('SELECT * FROM spins WHERE user_id=? AND date=?', [req.user.id, today], (err, spin) => {
    res.json({ spun: !!spin, reward: spin?.reward || null });
  });
});

app.post('/api/spin', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  db.get('SELECT * FROM spins WHERE user_id=? AND date=?', [req.user.id, today], (err, existing) => {
    if (existing) return res.status(400).json({ error: 'Ai dat deja spin azi!' });
    const reward = SPIN_PRIZES[Math.floor(Math.random() * SPIN_PRIZES.length)];
    db.run('INSERT INTO spins (user_id,date,reward) VALUES (?,?,?)', [req.user.id, today, reward], function(err) {
      if (err) return res.status(500).json({ error: 'Eroare server' });
      db.run('UPDATE users SET points=points+? WHERE id=?', [reward, req.user.id], () => {
        db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, u) => {
          res.json({ reward, total_points: u.points });
        });
      });
    });
  });
});

// ─── REACTIONS ───────────────────────────────────────────────────────────────
app.post('/api/reactions', auth, (req, res) => {
  const { to_user_id, emoji } = req.body;
  const allowed = ['🔥','❤️','😂','👑','💪','🎉'];
  if (!allowed.includes(emoji)) return res.status(400).json({ error: 'Emoji invalid' });
  if (to_user_id === req.user.id) return res.status(400).json({ error: 'Nu poti reactiona la tine' });
  const today = new Date().toISOString().slice(0, 10);
  db.run('INSERT OR REPLACE INTO reactions (from_user_id,to_user_id,emoji,date) VALUES (?,?,?,?)',
    [req.user.id, to_user_id, emoji, today], function(err) {
    res.json({ success: true });
  });
});

app.get('/api/reactions/:userId', (req, res) => {
  db.all(`SELECT emoji, COUNT(*) as cnt FROM reactions WHERE to_user_id=? GROUP BY emoji ORDER BY cnt DESC`,
    [req.params.userId], (err, rows) => {
    res.json(rows || []);
  });
});

// ─── INVITE / REFERRAL ───────────────────────────────────────────────────────
app.get('/api/invite', auth, (req, res) => {
  db.get('SELECT invite_code FROM users WHERE id=?', [req.user.id], (err, u) => {
    db.get('SELECT COUNT(*) as cnt FROM referrals WHERE user_id=? AND used_by IS NOT NULL', [req.user.id], (err, r) => {
      res.json({ code: u?.invite_code, accepted: r?.cnt || 0 });
    });
  });
});

app.post('/api/invite/use', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Cod lipsa' });
  db.get('SELECT * FROM referrals WHERE code=?', [code.toUpperCase()], (err, ref) => {
    if (!ref) {
      db.get('SELECT id FROM users WHERE invite_code=?', [code.toUpperCase()], (err, owner) => {
        if (!owner) return res.status(404).json({ error: 'Cod invalid' });
        if (owner.id === req.user.id) return res.status(400).json({ error: 'Nu poti folosi propriul cod' });
        db.get('SELECT * FROM referrals WHERE used_by=?', [req.user.id], (err, already) => {
          if (already) return res.status(400).json({ error: 'Ai folosit deja un cod' });
          db.run('INSERT INTO referrals (user_id,code,used_by,used_at) VALUES (?,?,?,CURRENT_TIMESTAMP)',
            [owner.id, code.toUpperCase(), req.user.id], function() {
            db.run('UPDATE users SET points=points+50 WHERE id=?', [owner.id]);
            db.run('UPDATE users SET points=points+30 WHERE id=?', [req.user.id], () => {
              db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, u) => {
                res.json({ success: true, bonus: 30, total_points: u.points, msg: 'Ai primit 30 puncte bonus! 🎉' });
              });
            });
          });
        });
      });
    } else {
      return res.status(400).json({ error: 'Cod invalid' });
    }
  });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || username.length < 3)
    return res.status(400).json({ error: 'Username minim 3 caractere' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Parola minim 4 caractere' });
  const hash = await bcrypt.hash(password, 10);
  const inviteCode = username.slice(0,3).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  db.run('INSERT INTO users (username, password, invite_code, email) VALUES (?, ?, ?, ?)', [username.toLowerCase(), hash, inviteCode, email||null], function(err) {
    if (err) return res.status(400).json({ error: 'Username ocupat' });
    const token = jwt.sign({ id: this.lastID, username: username.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: this.lastID, username: username.toLowerCase(), points: 0 } });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username?.toLowerCase()], async (err, user) => {
    if (!user) return res.status(400).json({ error: 'Username inexistent' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Parola gresita' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, points: user.points } });
  });
});

app.get('/api/daily', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  db.all('SELECT * FROM daily_pops WHERE user_id = ? AND date = ?', [req.user.id, today], (err, pops) => {
    const balloons = getTodayBalloons(req.user.id);
    res.json({ balloons, popped: pops.map(p => p.balloon_index), remaining: 3 - pops.length });
  });
});

app.post('/api/pop', auth, (req, res) => {
  const { balloon_index } = req.body;
  const today = new Date().toISOString().slice(0, 10);

  db.get('SELECT COUNT(*) as cnt FROM daily_pops WHERE user_id = ? AND date = ?', [req.user.id, today], (err, row) => {
    if (row.cnt >= 3) return res.status(400).json({ error: 'Ai spart toate baloanele de azi!' });

    db.get('SELECT * FROM daily_pops WHERE user_id = ? AND date = ? AND balloon_index = ?',
      [req.user.id, today, balloon_index], (err, ex) => {
      if (ex) return res.status(400).json({ error: 'Balon deja spart' });

      const balloons = getTodayBalloons(req.user.id);
      const bType = balloons[balloon_index];
      const pts = POINTS[bType] || 10;
      const isFirstPopToday = row.cnt === 0;
      const isLastBalloon = row.cnt + 1 === 3;
      const completionBonus = isLastBalloon ? 15 : 0;

      db.get('SELECT streak, last_pop_date, best_streak, week_str FROM users WHERE id=?', [req.user.id], (err, userRow) => {
        let newStreak = userRow.streak || 0;

        if (isFirstPopToday) {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yday = yesterday.toISOString().slice(0, 10);
          newStreak = (userRow.last_pop_date === yday) ? newStreak + 1 : 1;
        }

        const newBestStreak = Math.max(newStreak, userRow.best_streak || 0);
        const STREAK_MILESTONES = { 3: 15, 7: 35, 14: 70, 30: 150, 60: 300, 100: 500 };
        const streakBonus = (isFirstPopToday && STREAK_MILESTONES[newStreak]) ? STREAK_MILESTONES[newStreak] : 0;
        const totalPts = pts + completionBonus + streakBonus;

        const weekStr = getWeekStr();
        const weekReset = !userRow.week_str || userRow.week_str !== weekStr;

        db.run('INSERT INTO daily_pops (user_id, date, balloon_index, balloon_type, points_earned) VALUES (?,?,?,?,?)',
          [req.user.id, today, balloon_index, bType, pts], function(err) {
          if (err) return res.status(500).json({ error: 'Eroare server' });

          db.run(`UPDATE users SET points=points+?, last_pop_date=?, streak=?, best_streak=?, total_pops=COALESCE(total_pops,0)+1,
            weekly_points=CASE WHEN week_str=? THEN COALESCE(weekly_points,0)+? ELSE ? END, week_str=? WHERE id=?`,
            [totalPts, today, newStreak, newBestStreak, weekStr, totalPts, totalPts, weekStr, req.user.id], () => {
            db.get('SELECT points, streak, total_pops FROM users WHERE id=?', [req.user.id], (err, u) => {
              res.json({
                points_earned: pts,
                bonus: completionBonus,
                streak_bonus: streakBonus,
                total_points: u.points,
                balloon_type: bType,
                streak: u.streak,
                total_pops: u.total_pops,
                all_done: isLastBalloon,
                streak_changed: isFirstPopToday
              });
            });
          });
        });
      });
    });
  });
});

app.get('/api/me', auth, (req, res) => {
  db.get('SELECT id,username,points,streak,best_streak,total_pops,char_hat,char_eyes,char_outfit,char_bg,char_skin,char_frame,char_card_style,invite_code,created_at,best_arcade_stage,email FROM users WHERE id=?', [req.user.id], (err, user) => {
    db.all('SELECT item_id FROM owned_items WHERE user_id=?', [req.user.id], (err, items) => {
      res.json({ ...user, owned_items: items.map(i => i.item_id) });
    });
  });
});

app.get('/api/profile/:id', (req, res) => {
  db.get('SELECT id,username,points,streak,best_streak,total_pops,char_hat,char_eyes,char_outfit,char_bg,char_skin,char_frame,char_card_style FROM users WHERE id=?', [req.params.id], (err, user) => {
    if (!user) return res.status(404).json({ error: 'User negasit' });
    db.all('SELECT item_id FROM owned_items WHERE user_id=?', [user.id], (err, items) => {
      res.json({ ...user, owned_items: items.map(i => i.item_id) });
    });
  });
});

const SHOP = {
  // Hats
  'hat_party':      { name: 'Palarie Party',    cost: 50,   slot: 'hat',    emoji: '🎉' },
  'hat_bunny':      { name: 'Urechi Iepuras',   cost: 100,  slot: 'hat',    emoji: '🐰' },
  'hat_cap':        { name: 'Sepca',             cost: 80,   slot: 'hat',    emoji: '🧢' },
  'hat_tophat':     { name: 'Joben',             cost: 150,  slot: 'hat',    emoji: '🎩' },
  'hat_crown':      { name: 'Coroana',           cost: 500,  slot: 'hat',    emoji: '👑' },
  'hat_cowboy':     { name: 'Cowboy',            cost: 200,  slot: 'hat',    emoji: '🤠' },
  // Eyes
  'eyes_sunglasses':{ name: 'Ochelari Soare',   cost: 100,  slot: 'eyes',   emoji: '😎' },
  'eyes_heart':     { name: 'Ochi Inima',        cost: 200,  slot: 'eyes',   emoji: '😍' },
  'eyes_star':      { name: 'Ochi Stea',         cost: 300,  slot: 'eyes',   emoji: '🤩' },
  'eyes_evil':      { name: 'Ochi Rai',          cost: 250,  slot: 'eyes',   emoji: '😈' },
  // Outfits
  'outfit_rainbow': { name: 'Outfit Curcubeu',   cost: 400,  slot: 'outfit', emoji: '🌈' },
  'outfit_fire':    { name: 'Outfit Foc',        cost: 350,  slot: 'outfit', emoji: '🔥' },
  'outfit_gold':    { name: 'Outfit Auriu',      cost: 600,  slot: 'outfit', emoji: '✨' },
  'outfit_dark':    { name: 'Outfit Dark',       cost: 250,  slot: 'outfit', emoji: '🖤' },
  // Backgrounds
  'bg_sunset':      { name: 'Fundal Apus',       cost: 500,  slot: 'bg',     emoji: '🌅' },
  'bg_forest':      { name: 'Fundal Padure',     cost: 700,  slot: 'bg',     emoji: '🌲' },
  'bg_space':       { name: 'Fundal Spatiu',     cost: 800,  slot: 'bg',     emoji: '🌌' },
  'bg_rainbow':     { name: 'Fundal Curcubeu',   cost: 1200, slot: 'bg',     emoji: '🌈' },
  // Carti Brainrot
  'skin_gigachad':    { name: 'Gigachado Supremo',      cost: 1500, slot: 'skin',   emoji: '😤' },
  'skin_npc':         { name: 'NPC-047 Robotino',       cost: 600,  slot: 'skin',   emoji: '🤖' },
  'skin_capy':        { name: 'Capybarino Relaxino',    cost: 900,  slot: 'skin',   emoji: '🐾' },
  'skin_tralalero':   { name: 'Tralalello Tralale',     cost: 2000, slot: 'skin',   emoji: '🦈' },
  'skin_bombardiro':  { name: 'Bombardino Crocodillo',  cost: 2000, slot: 'skin',   emoji: '🐊' },
  'skin_mewing':      { name: 'Mewingo el Jawlino',     cost: 800,  slot: 'skin',   emoji: '🫡' },
  'skin_rizz':        { name: 'Rizzerino el Kingino',   cost: 1200, slot: 'skin',   emoji: '😏' },
  'skin_pepe':        { name: 'Pepino el Ranito',       cost: 700,  slot: 'skin',   emoji: '🐸' },
  'skin_doge':        { name: 'Dogino Sucho Sucho',     cost: 1000, slot: 'skin',   emoji: '🐕' },
  'skin_skibidi':     { name: 'Skibidino el Toiletino', cost: 1500, slot: 'skin',   emoji: '🚽' },
  'skin_tung':        { name: 'Tung Tung Sahurino',     cost: 1200, slot: 'skin',   emoji: '🥁' },
  'skin_bonk':        { name: 'Bonkino el Dawgo',       cost: 600,  slot: 'skin',   emoji: '🏏' },
  'skin_sigma':       { name: 'Sigmarino el Stonko',    cost: 1000, slot: 'skin',   emoji: '🗿' },
  'skin_sus':         { name: 'Imposturino el Sussino', cost: 800,  slot: 'skin',   emoji: '📮' },
  'skin_karen':       { name: 'Kareno el Managero',     cost: 700,  slot: 'skin',   emoji: '💇' },
  'skin_chad':        { name: 'Chadino el Virgino',     cost: 1100, slot: 'skin',   emoji: '🚶' },
  'skin_crycat':      { name: 'Gatino el Llorino',      cost: 500,  slot: 'skin',   emoji: '😿' },
  'skin_ballerina':   { name: 'Ballerina Cappucina',    cost: 1200, slot: 'skin',   emoji: '🩰' },
  'skin_rizzler':     { name: 'Rizzlerino el Grande',   cost: 1800, slot: 'skin',   emoji: '😎' },
  'skin_ohio':        { name: 'Ohio Bizzarro el Strange',cost: 1600, slot: 'skin',   emoji: '👁' },
  'skin_copium':      { name: 'Copiumino el Hopino',    cost: 900,  slot: 'skin',   emoji: '😮' },
  'skin_bozo':        { name: 'Bozino el Clownito',     cost: 800,  slot: 'skin',   emoji: '🤡' },
  'skin_delulu':      { name: 'Delulina la Reginita',   cost: 1400, slot: 'skin',   emoji: '🌸' },
  'skin_drip':        { name: 'Dripino el Swaggino',    cost: 2000, slot: 'skin',   emoji: '💧' },
  'skin_goat':        { name: 'El Goato Supremissimo',  cost: 3000, slot: 'skin',   emoji: '🐐' },
  'skin_pookie':      { name: 'Pookino Bearino',        cost: 700,  slot: 'skin',   emoji: '🐻' },
  'skin_cooked':      { name: 'Cookino el Stressino',   cost: 600,  slot: 'skin',   emoji: '🥵' },
  'skin_fanum':       { name: 'Fanumino el Taxino',     cost: 1100, slot: 'skin',   emoji: '🍕' },
  'skin_yapping':     { name: 'Yapperino el Babbino',   cost: 800,  slot: 'skin',   emoji: '🗣' },
  'skin_glazing':     { name: 'Glazerino el Enjoyero',  cost: 900,  slot: 'skin',   emoji: '✨' },
  'skin_looksmax':    { name: 'Looksmaxerino Grande',   cost: 1500, slot: 'skin',   emoji: '💪' },
  'skin_slay':        { name: 'Slayqueen Royalino',     cost: 1800, slot: 'skin',   emoji: '👑' },
  'skin_bussin':      { name: 'Bussino el Brossino',    cost: 700,  slot: 'skin',   emoji: '😋' },
  'skin_based':       { name: 'Basedino Sigmarino',     cost: 1300, slot: 'skin',   emoji: '🗿' },
  'skin_vibe':        { name: 'Vibecheckino el Freshino',cost: 1000, slot: 'skin',   emoji: '🎧' },
  'skin_hawk':        { name: 'Hawk Tuahino el Cowboyino',cost:1200, slot: 'skin',  emoji: '🤠' },
  'skin_ratio':       { name: 'Ratioguy el Phonino',    cost: 900,  slot: 'skin',   emoji: '📱' },
  'skin_cringe':      { name: 'Cringerlino el Awkwardo', cost: 500, slot: 'skin',   emoji: '😅' },
  'skin_frigo':       { name: 'Frigocamelo el Arctino', cost: 2200, slot: 'skin',   emoji: '🐪' },
  'skin_lirili':      { name: 'Lirilino el Larilino',   cost: 1800, slot: 'skin',   emoji: '🐘' },
  'skin_gyat':        { name: 'Gyatino el Swagmastero', cost: 1500, slot: 'skin',   emoji: '💅' },

  // --- New image cards (Wikimedia Commons) ---
  'skin_merluzzini':  { name: 'Merluzzini Marraquetini', cost: 1800, slot: 'skin', emoji: '🐟' },
  'skin_frulli':      { name: 'Frulli Frulla',           cost: 1400, slot: 'skin', emoji: '🌀' },
  'skin_giraffa':     { name: 'Giraffa Celeste',         cost: 2200, slot: 'skin', emoji: '🦒' },
  'skin_cavallo':     { name: 'Ecco Cavallo Virtuoso',   cost: 2600, slot: 'skin', emoji: '🐴' },

  // --- Card Styles (global card visual themes) ---
  'style_gold':    { name: 'Gold Foil',    cost: 8000,   slot: 'cardstyle', emoji: '✨' },
  'style_neon':    { name: 'Neon Glow',    cost: 12000,  slot: 'cardstyle', emoji: '💡' },
  'style_dark':    { name: 'Dark Aura',    cost: 10000,  slot: 'cardstyle', emoji: '🖤' },
  'style_fire':    { name: 'Fire Edition', cost: 15000,  slot: 'cardstyle', emoji: '🔥' },
  'style_holo':    { name: 'Holographic',  cost: 25000,  slot: 'cardstyle', emoji: '🌈' },

  // --- Card Frames ---
  'frame_gold':    { name: 'Rama Aurie',        cost: 3000,   slot: 'frame', emoji: '🟡' },
  'frame_neon':    { name: 'Neon Violet',        cost: 5000,   slot: 'frame', emoji: '💜' },
  'frame_fire':    { name: 'Rama de Foc',        cost: 8000,   slot: 'frame', emoji: '🔥' },
  'frame_ice':     { name: 'Crystal Ice',        cost: 10000,  slot: 'frame', emoji: '🧊' },
  'frame_holo':    { name: 'Holographic',        cost: 20000,  slot: 'frame', emoji: '🌈' },
  'frame_shadow':  { name: 'Dark Shadow',        cost: 15000,  slot: 'frame', emoji: '🖤' },
  'frame_star':    { name: 'Stardust',           cost: 12000,  slot: 'frame', emoji: '⭐' },
  'frame_diamond': { name: 'Diamond Elite',      cost: 50000,  slot: 'frame', emoji: '💎' },

  // --- Common (200-800) ---
  'skin_noobini_pizza':   { name: 'Noobini Pizzanini',        cost: 200,  slot: 'skin', emoji: '🍕' },
  'skin_lirili_la':       { name: 'Lirili Larila',            cost: 300,  slot: 'skin', emoji: '🐘' },
  'skin_tim_cheese':      { name: 'Tim Cheese',               cost: 250,  slot: 'skin', emoji: '🧀' },
  'skin_fluriflura':      { name: 'FluriFlura',               cost: 400,  slot: 'skin', emoji: '🌸' },
  'skin_talpa_fero':      { name: 'Talpa Di Fero',            cost: 350,  slot: 'skin', emoji: '🦔' },
  'skin_svinina':         { name: 'Svinina Bombardino',       cost: 500,  slot: 'skin', emoji: '🐷' },
  'skin_pipi_kiwi':       { name: 'Pipi Kiwi',               cost: 300,  slot: 'skin', emoji: '🥝' },
  'skin_racooni':         { name: 'Racooni Jandelini',        cost: 450,  slot: 'skin', emoji: '🦝' },
  'skin_pipi_corni':      { name: 'Pipi Corni',               cost: 350,  slot: 'skin', emoji: '🌽' },
  'skin_noobini_santa':   { name: 'Noobini Santanini',        cost: 600,  slot: 'skin', emoji: '🎅' },

  // --- Rare (800-2500) ---
  'skin_trippi_troppi':   { name: 'Trippi Troppi',            cost: 800,  slot: 'skin', emoji: '🦋' },
  'skin_gangster_foot':   { name: 'Gangster Footera',         cost: 1000, slot: 'skin', emoji: '👟' },
  'skin_bandito_bob':     { name: 'Bandito Bobritto',         cost: 1200, slot: 'skin', emoji: '🦫' },
  'skin_boneca_amb':      { name: 'Boneca Ambalabu',          cost: 1500, slot: 'skin', emoji: '🎎' },
  'skin_cacto_hipo':      { name: 'Cacto Hipopotamo',         cost: 1100, slot: 'skin', emoji: '🦛' },
  'skin_ta_sahur':        { name: 'Ta Ta Ta Ta Sahur',        cost: 2000, slot: 'skin', emoji: '🥁' },
  'skin_tric_trac':       { name: 'Tric Trac Baraboom',       cost: 1800, slot: 'skin', emoji: '💥' },
  'skin_pipi_avocado':    { name: 'Pipi Avocado',             cost: 900,  slot: 'skin', emoji: '🥑' },
  'skin_frogo_elfo':      { name: 'Frogo Elfo',               cost: 2500, slot: 'skin', emoji: '🧝' },

  // --- Epic (2500-6000) ---
  'skin_cappuccino_ass':  { name: 'Cappuccino Assassino',     cost: 2500, slot: 'skin', emoji: '☕' },
  'skin_brr_patapim':     { name: 'Brr Brr Patapim',         cost: 3000, slot: 'skin', emoji: '🥁' },
  'skin_trulimero':       { name: 'Trulimero Trulicina',      cost: 3500, slot: 'skin', emoji: '🎭' },
  'skin_bambini_crost':   { name: 'Bambini Crostini',         cost: 2800, slot: 'skin', emoji: '🥐' },
  'skin_bananita_dolph':  { name: 'Bananita Dolphinita',      cost: 4000, slot: 'skin', emoji: '🐬' },
  'skin_perochello':      { name: 'Perochello Lemonchello',   cost: 3200, slot: 'skin', emoji: '🍋' },
  'skin_brri_bombicus':   { name: 'Brri Brri Bicus Dicus Bombicus', cost: 5000, slot: 'skin', emoji: '💣' },
  'skin_avocadini_guf':   { name: 'Avocadini Guffo',         cost: 3800, slot: 'skin', emoji: '🦉' },
  'skin_salamino_peng':   { name: 'Salamino Penguino',        cost: 4500, slot: 'skin', emoji: '🐧' },
  'skin_ti_sahur':        { name: 'Ti Ti Ti Sahur',           cost: 5500, slot: 'skin', emoji: '🌙' },
  'skin_penguin_tree':    { name: 'Penguin Tree',             cost: 4200, slot: 'skin', emoji: '🌲' },
  'skin_penguino_coco':   { name: 'Penguino Cocosino',        cost: 6000, slot: 'skin', emoji: '🥥' },

  // --- Legendary (6000-25000) ---
  'skin_burbaloni':       { name: 'Burbaloni Loliloli',       cost: 6000,  slot: 'skin', emoji: '🫧' },
  'skin_chimpazini':      { name: 'Chimpazini Bananini',      cost: 8000,  slot: 'skin', emoji: '🦧' },
  'skin_chef_crab':       { name: 'Chef Crabracadabra',       cost: 10000, slot: 'skin', emoji: '🦀' },
  'skin_lionel_cact':     { name: 'Lionel Cactuseli',         cost: 12000, slot: 'skin', emoji: '🌵' },
  'skin_glorbo_frutt':    { name: 'Glorbo Fruttodrillo',      cost: 9000,  slot: 'skin', emoji: '🐊' },
  'skin_blueberrini':     { name: 'Blueberrini Octopusini',   cost: 15000, slot: 'skin', emoji: '🐙' },
  'skin_strawberelli':    { name: 'Strawberelli Flamingelli',  cost: 14000, slot: 'skin', emoji: '🦩' },
  'skin_pandaccini':      { name: 'Pandaccini Bananini',      cost: 11000, slot: 'skin', emoji: '🐼' },
  'skin_cocosini_mama':   { name: 'Cocosini Mama',            cost: 13000, slot: 'skin', emoji: '🥥' },
  'skin_sigma_boy':       { name: 'Sigma Boy',                cost: 18000, slot: 'skin', emoji: '💪' },
  'skin_sigma_girl':      { name: 'Sigma Girl',               cost: 18000, slot: 'skin', emoji: '👑' },
  'skin_pi_watermelon':   { name: 'Pi Pi Watermelon',         cost: 20000, slot: 'skin', emoji: '🍉' },
  'skin_chocco_bunny':    { name: 'Chocco Bunny',             cost: 16000, slot: 'skin', emoji: '🐰' },
  'skin_sealo_regalo':    { name: 'Sealo Regalo',             cost: 25000, slot: 'skin', emoji: '🦭' },

  // --- Mythic (25000-100000) ---
  'skin_frigo_camelo':    { name: 'Frigo Camelo',             cost: 30000,  slot: 'skin', emoji: '🐪' },
  'skin_orangutini':      { name: 'Orangutini Ananassini',    cost: 50000,  slot: 'skin', emoji: '🦧' },
  'skin_rhino_toast':     { name: 'Rhino Toasterino',         cost: 40000,  slot: 'skin', emoji: '🦏' },
  'skin_bombardiro_croc': { name: 'Bombardiro Crocodilo',     cost: 75000,  slot: 'skin', emoji: '🐊' },
  'skin_bombombini_gus':  { name: 'Bombombini Gusini',        cost: 100000, slot: 'skin', emoji: '💥' },

  // --- Brainrot God (100000-500000) ---
  'skin_brainrot_god':    { name: 'Brainrot God',             cost: 250000, slot: 'skin', emoji: '🧠' },

  // --- Secret (500000-5000000) ---
  'skin_secret_one':      { name: '??? Secret ???',           cost: 999999, slot: 'skin', emoji: '❓' },

  // --- OG (5000000+) ---
  'skin_og_original':     { name: 'OG Original Brainrot',     cost: 5000000, slot: 'skin', emoji: '🏆' },

  // --- ULTRA RARE (Arcade drop only, cannot be bought, ~0.1% chance) ---
  'skin_ultra_phoenix':   { name: 'Phoenixus Infernalis',     cost: 0, slot: 'skin', emoji: '🔥', arcadeOnly: true, rarity: 'ultra' },
  'skin_ultra_void':      { name: 'Void Walker Supremus',     cost: 0, slot: 'skin', emoji: '🌀', arcadeOnly: true, rarity: 'ultra' },
  'skin_ultra_cosmos':    { name: 'Cosmicus Absolutus Rex',   cost: 0, slot: 'skin', emoji: '🌌', arcadeOnly: true, rarity: 'ultra' },
};

app.get('/api/shop', (req, res) => res.json(SHOP));

app.post('/api/buy', auth, (req, res) => {
  const { item_id } = req.body;
  const item = SHOP[item_id];
  if (!item) return res.status(400).json({ error: 'Item inexistent' });
  db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, user) => {
    if (user.points < item.cost) return res.status(400).json({ error: 'Puncte insuficiente' });
    db.run('INSERT OR IGNORE INTO owned_items (user_id, item_id) VALUES (?,?)', [req.user.id, item_id], function(err) {
      if (this.changes === 0) return res.status(400).json({ error: 'Item deja detinut' });
      db.run('UPDATE users SET points=points-? WHERE id=?', [item.cost, req.user.id], () => {
        db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, u) => {
          res.json({ success: true, remaining_points: u.points });
        });
      });
    });
  });
});

app.post('/api/equip', auth, (req, res) => {
  const { item_id, slot } = req.body;
  const colMap = { hat:'char_hat', eyes:'char_eyes', outfit:'char_outfit', bg:'char_bg', skin:'char_skin', frame:'char_frame', cardstyle:'char_card_style' };
  const defaultMap = { hat:'none', eyes:'normal', outfit:'default', bg:'blue', skin:'chibi', frame:'none', cardstyle:'none' };
  const col = colMap[slot];
  if (!col) return res.status(400).json({ error: 'Slot invalid' });
  if (item_id === 'none' || item_id === 'chibi') {
    db.run(`UPDATE users SET ${col}=? WHERE id=?`, [defaultMap[slot], req.user.id], () => res.json({ success: true }));
    return;
  }
  db.get('SELECT * FROM owned_items WHERE user_id=? AND item_id=?', [req.user.id, item_id], (err, owned) => {
    if (!owned) return res.status(400).json({ error: 'Item nedetinut' });
    db.run(`UPDATE users SET ${col}=? WHERE id=?`, [item_id, req.user.id], () => res.json({ success: true }));
  });
});

app.get('/api/leaderboard', (req, res) => {
  db.all('SELECT id,username,points,streak,char_hat,char_bg,char_eyes,char_outfit,char_skin FROM users ORDER BY points DESC LIMIT 20', [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/leaderboard/weekly', (req, res) => {
  const weekStr = getWeekStr();
  db.all('SELECT id,username,weekly_points,streak,char_skin FROM users WHERE week_str=? ORDER BY weekly_points DESC LIMIT 20', [weekStr], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/stats', auth, (req, res) => {
  db.get('SELECT total_pops,best_streak,created_at FROM users WHERE id=?', [req.user.id], (err, user) => {
    db.get("SELECT balloon_type, COUNT(*) as cnt FROM daily_pops WHERE user_id=? GROUP BY balloon_type ORDER BY cnt DESC LIMIT 1",
      [req.user.id], (err, fav) => {
      res.json({
        total_pops: user?.total_pops || 0,
        best_streak: user?.best_streak || 0,
        favorite_balloon: fav?.balloon_type || null,
        member_since: user?.created_at
      });
    });
  });
});

app.delete('/api/users/me', auth, (req, res) => {
  const userId = req.user.id;
  db.run('DELETE FROM daily_pops WHERE user_id=?', [userId]);
  db.run('DELETE FROM owned_items WHERE user_id=?', [userId]);
  db.run('DELETE FROM spins WHERE user_id=?', [userId]);
  db.run('DELETE FROM mission_claims WHERE user_id=?', [userId]);
  db.run('DELETE FROM reactions WHERE from_user_id=? OR to_user_id=?', [userId, userId]);
  db.run('DELETE FROM referrals WHERE user_id=?', [userId]);
  db.run('DELETE FROM users WHERE id=?', [userId], (err) => {
    if (err) return res.status(500).json({ error: 'Eroare server' });
    res.json({ success: true });
  });
});

app.post('/api/arcade/reward', auth, (req, res) => {
  const { points, card_id } = req.body;
  const pts = Math.min(Math.max(parseInt(points)||0, 0), 9999);
  if(card_id) {
    const item = SHOP[card_id];
    if(!item || item.slot !== 'skin') {
      db.run('UPDATE users SET points=points+? WHERE id=?', [pts, req.user.id], ()=>{
        db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, u)=>{
          res.json({success:true, total_points: u.points});
        });
      });
      return;
    }
    db.run('INSERT OR IGNORE INTO owned_items (user_id, item_id) VALUES (?,?)', [req.user.id, card_id], function() {
      const cardGiven = this.changes > 0;
      db.run('UPDATE users SET points=points+? WHERE id=?', [pts, req.user.id], ()=>{
        db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, u)=>{
          res.json({success:true, total_points: u.points, card_name: cardGiven ? item.name : null});
        });
      });
    });
  } else {
    if(pts === 0) return res.json({success:true, total_points: 0});
    db.run('UPDATE users SET points=points+? WHERE id=?', [pts, req.user.id], ()=>{
      db.get('SELECT points FROM users WHERE id=?', [req.user.id], (err, u)=>{
        res.json({success:true, total_points: u.points});
      });
    });
  }
});

// ─── SOCIAL FEED ────────────────────────────────────────────────────────────
app.get('/api/users/feed', auth, (req, res) => {
  db.all(
    `SELECT id, username, points, streak, best_arcade_stage, char_skin
     FROM users
     WHERE id != ?
     ORDER BY points DESC
     LIMIT 20`,
    [req.user.id],
    (err, users) => {
      if (err || !users) return res.json([]);
      const ids = users.map(u => u.id);
      if (!ids.length) return res.json([]);
      db.all(
        `SELECT user_id, item_id FROM owned_items
         WHERE user_id IN (${ids.map(() => '?').join(',')})
         AND item_id LIKE 'skin_%'`,
        ids,
        (err2, items) => {
          const byUser = {};
          (items || []).forEach(i => {
            if (!byUser[i.user_id]) byUser[i.user_id] = [];
            byUser[i.user_id].push(i.item_id);
          });
          const result = users.map(u => {
            const owned = byUser[u.id] || [];
            // top 3 cards: prioritise expensive ones
            const sorted = owned
              .filter(id => SHOP[id])
              .sort((a, b) => (SHOP[b]?.cost || 0) - (SHOP[a]?.cost || 0));
            return {
              id: u.id,
              username: u.username,
              points: u.points || 0,
              streak: u.streak || 0,
              arcade_stage: u.best_arcade_stage || 0,
              skin: u.char_skin || null,
              cards_count: owned.length,
              top_cards: sorted.slice(0, 3)
            };
          });
          res.json(result);
        }
      );
    }
  );
});

app.post('/api/arcade/stage', auth, (req, res) => {
  const { stage } = req.body;
  const s = Math.max(parseInt(stage)||0, 0);
  db.run('UPDATE users SET best_arcade_stage=MAX(COALESCE(best_arcade_stage,0),?) WHERE id=?', [s, req.user.id], () => {
    res.json({ success: true });
  });
});

app.post('/api/forgot-password', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username lipsa' });
  db.get('SELECT id, username, email FROM users WHERE username=?', [username.toLowerCase()], (err, user) => {
    if (!user) return res.status(404).json({ error: 'Username inexistent' });
    if (!user.email) return res.status(400).json({ error: 'Nu ai email salvat. Contacteaza suportul.' });
    const token = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    db.run('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)', [user.id, token, expires], function(err) {
      if (err) return res.status(500).json({ error: 'Eroare server' });
      // TODO: Send email with reset link
      // For now, return token directly (only in dev) - in prod, send via email
      const resetLink = `https://kboom.enjoyme.com.ro/reset-password?token=${token}`;
      console.log('Reset link for', user.username, ':', resetLink);
      res.json({ success: true, msg: 'Daca username-ul exista, vei primi un email cu instructiuni.' });
    });
  });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.status(400).json({ error: 'Date lipsa' });
  if (new_password.length < 4) return res.status(400).json({ error: 'Parola minim 4 caractere' });
  const now = new Date().toISOString();
  db.get('SELECT * FROM password_reset_tokens WHERE token=? AND used=0 AND expires_at > ?', [token, now], async (err, row) => {
    if (!row) return res.status(400).json({ error: 'Token invalid sau expirat' });
    const hash = await bcrypt.hash(new_password, 10);
    db.run('UPDATE users SET password=? WHERE id=?', [hash, row.user_id], (err) => {
      if (err) return res.status(500).json({ error: 'Eroare server' });
      db.run('UPDATE password_reset_tokens SET used=1 WHERE token=?', [token], () => {
        res.json({ success: true, msg: 'Parola schimbata cu succes!' });
      });
    });
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'www', 'index.html')));

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => console.log(`K-Boom running on port ${PORT}`));
