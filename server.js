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
  const { username, password } = req.body;
  if (!username || !password || username.length < 3)
    return res.status(400).json({ error: 'Username minim 3 caractere' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Parola minim 4 caractere' });
  const hash = await bcrypt.hash(password, 10);
  const inviteCode = username.slice(0,3).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  db.run('INSERT INTO users (username, password, invite_code) VALUES (?, ?, ?)', [username.toLowerCase(), hash, inviteCode], function(err) {
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

      db.get('SELECT streak, last_pop_date, best_streak FROM users WHERE id=?', [req.user.id], (err, userRow) => {
        let newStreak = userRow.streak || 0;

        if (isFirstPopToday) {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yday = yesterday.toISOString().slice(0, 10);
          newStreak = (userRow.last_pop_date === yday) ? newStreak + 1 : 1;
        }

        const newBestStreak = Math.max(newStreak, userRow.best_streak || 0);
        const totalPts = pts + completionBonus;

        db.run('INSERT INTO daily_pops (user_id, date, balloon_index, balloon_type, points_earned) VALUES (?,?,?,?,?)',
          [req.user.id, today, balloon_index, bType, pts], function(err) {
          if (err) return res.status(500).json({ error: 'Eroare server' });

          db.run('UPDATE users SET points=points+?, last_pop_date=?, streak=?, best_streak=?, total_pops=COALESCE(total_pops,0)+1 WHERE id=?',
            [totalPts, today, newStreak, newBestStreak, req.user.id], () => {
            db.get('SELECT points, streak, total_pops FROM users WHERE id=?', [req.user.id], (err, u) => {
              res.json({
                points_earned: pts,
                bonus: completionBonus,
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
  db.get('SELECT id,username,points,streak,best_streak,total_pops,char_hat,char_eyes,char_outfit,char_bg,char_skin,invite_code,created_at FROM users WHERE id=?', [req.user.id], (err, user) => {
    db.all('SELECT item_id FROM owned_items WHERE user_id=?', [req.user.id], (err, items) => {
      res.json({ ...user, owned_items: items.map(i => i.item_id) });
    });
  });
});

app.get('/api/profile/:id', (req, res) => {
  db.get('SELECT id,username,points,streak,best_streak,total_pops,char_hat,char_eyes,char_outfit,char_bg,char_skin FROM users WHERE id=?', [req.params.id], (err, user) => {
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
  const colMap = { hat:'char_hat', eyes:'char_eyes', outfit:'char_outfit', bg:'char_bg', skin:'char_skin' };
  const defaultMap = { hat:'none', eyes:'normal', outfit:'default', bg:'blue', skin:'chibi' };
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'www', 'index.html')));

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => console.log(`K-Boom running on port ${PORT}`));
