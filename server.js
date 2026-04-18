const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const basicAuth = require('express-basic-auth');
const multer = require('multer');
const AdmZip = require('adm-zip');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));
const upload = multer({ dest: os.tmpdir() });

app.use(basicAuth({
    users: { 'superadmin': 'Champion@1986' },
    challenge: true,
    realm: 'VPS Dashboard Secure Area'
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024, dm = 1, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
function formatUptime(uptimeMs) {
    const totalSeconds = Math.floor((Date.now() - uptimeMs) / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${h}h ${m}m`;
}

// Stats API
app.get('/api/stats', (req, res) => {
    let result = { pm2: [], nginx: [], disk: {}, memory: {} };
    
    // 0. Get Memory
    exec('free -m', (errM, stdoutM) => {
        if (!errM) {
            const lines = stdoutM.trim().split('\n');
            if (lines.length > 1) {
                const parts = lines[1].replace(/\s+/g, ' ').split(' ');
                result.memory = { 
                    total: parts[1] + ' MB', 
                    used: parts[2] + ' MB', 
                    free: parts[3] + ' MB', 
                    percent: Math.round((parseInt(parts[2]) / parseInt(parts[1])) * 100) + '%' 
                };
            }
        }

        exec('df -h /', (errD, stdoutD) => {
            if (!errD) {
                const lines = stdoutD.trim().split('\n');
                if (lines.length > 1) {
                    const parts = lines[1].replace(/\s+/g, ' ').split(' ');
                    result.disk = { size: parts[1], used: parts[2], avail: parts[3], percent: parts[4] };
                }
            }
            
            exec('pm2 jlist', (err2, stdout2) => {
                if (!err2) {
                    try {
                        const processes = JSON.parse(stdout2);
                        result.pm2 = processes.map(p => ({
                            name: p.name,
                            status: p.pm2_env.status,
                            memory: formatBytes(p.monit.memory),
                            cpu: p.monit.cpu,
                            uptime: formatUptime(p.pm2_env.pm_uptime),
                            restarts: p.pm2_env.restart_time
                        }));
                    } catch(e) {}
                }
                
                exec('ls -1 /etc/nginx/sites-available/', (err1, stdout1) => {
                    const available = !err1 ? stdout1.split('\n').filter(l => l.trim() !== '') : [];
                    exec('ls -1 /etc/nginx/sites-enabled/', async (errE, stdoutE) => {
                        const enabled = !errE ? stdoutE.split('\n').filter(l => l.trim() !== '') : [];
                        
                        const nginxPromises = available.map(site => new Promise((resolve) => {
                            const isEnabled = enabled.includes(site);
                            fs.readFile(`/etc/nginx/sites-available/${site}`, 'utf8', (errR, content) => {
                                let size = '-';
                                let hasSSL = false;
                                let domain = 'Unknown';
                                if (!errR) {
                                    hasSSL = content.includes('ssl_certificate');
                                    
                                    const serverMatch = content.match(/server_name\s+([^;]+);/);
                                    if (serverMatch && serverMatch[1]) {
                                        domain = serverMatch[1].trim().split(' ')[0]; // Gets main domain
                                    }

                                    const match = content.match(/root\s+([^;]+);/);
                                    if (match && match[1]) {
                                        const rootPath = match[1].trim();
                                        try {
                                            const duOut = execSync(`du -sh ${rootPath} 2>/dev/null`, {encoding:'utf8'});
                                            size = duOut.split('\t')[0].trim();
                                        } catch(e) { size = '?'; }
                                    }
                                }
                                resolve({ name: site, domain: domain, status: isEnabled ? 'online' : 'stopped', size: size, hasSSL: hasSSL });
                            });
                        }));
                        
                        result.nginx = await Promise.all(nginxPromises);
                        res.json(result);
                    });
                });
            });
        });
    });
});

// Domain Change API
app.post('/api/nginx/change-domain', (req, res) => {
    const { oldSite, newDomain } = req.body;
    if (!oldSite || !newDomain || !/^[a-zA-Z0-9.-]+$/.test(newDomain)) {
        return res.status(400).json({ error: 'Invalid domain name format.' });
    }
    
    const oldPath = `/etc/nginx/sites-available/${oldSite}`;
    fs.readFile(oldPath, 'utf8', (err, content) => {
        if (err) return res.status(500).json({ error: 'Cannot read old site configuration: ' + err.message });
        
        const rootMatch = content.match(/root\s+([^;]+);/);
        if (!rootMatch || !rootMatch[1]) {
            return res.status(500).json({ error: 'Cannot determine the root folder target from old config!' });
        }
        const rootTarget = rootMatch[1].trim();
        
        const newConfig = `server {
    listen 80;
    server_name ${newDomain} www.${newDomain};
    root ${rootTarget};
    index index.html index.htm index.js;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
        const newPath = `/etc/nginx/sites-available/${newDomain}`;
        
        fs.writeFile(newPath, newConfig, (writeErr) => {
            if (writeErr) return res.status(500).json({ error: 'Failed to write new config: ' + writeErr });
            
            exec(`rm -f /etc/nginx/sites-enabled/${oldSite}`, () => {
                exec(`rm -f /etc/nginx/sites-available/${oldSite}`, () => {
                    exec(`ln -sf /etc/nginx/sites-available/${newDomain} /etc/nginx/sites-enabled/${newDomain}`, (linkErr) => {
                         if (linkErr) return res.status(500).json({ error: 'Failed to bring online: ' + linkErr });
                         exec('systemctl reload nginx', () => res.json({ success: true }));
                    });
                });
            });
        });
    });
});

// PM2 Controls
app.post('/api/pm2/action', (req, res) => {
    const { action, name } = req.body;
    if (!['restart', 'stop', 'delete', 'start'].includes(action)) return res.status(400).json({error: 'Invalid action'});
    exec(`pm2 ${action} ${name}`, (err, stdout) => {
        if (err) return res.status(500).json({error: err.message});
        exec('pm2 save', () => res.json({success: true}));
    });
});
app.get('/api/pm2/logs', (req, res) => {
    const name = req.query.name;
    exec(`pm2 logs ${name} --lines 100 --nostream`, (err, stdout) => {
        res.json({ logs: stdout || err?.message || 'No logs available' });
    });
});

// Nginx Controls
app.get('/api/nginx/read', (req, res) => {
    const file = path.join('/etc/nginx/sites-available', path.basename(req.query.file));
    fs.readFile(file, 'utf8', (err, data) => res.json({ content: err ? err.message : data }));
});
app.post('/api/nginx/save', (req, res) => {
    const file = path.join('/etc/nginx/sites-available', path.basename(req.body.file));
    const content = req.body.content || '';
    fs.writeFile(file, content, (err) => {
        if (err) return res.status(500).json({error: err.message});
        exec('nginx -t', (errT, stdoutT, stderrT) => {
            if (errT) return res.status(400).json({error: stderrT || errT.message});
            exec('systemctl reload nginx', () => res.json({success: true}));
        });
    });
});
app.post('/api/nginx/toggle', (req, res) => {
    const { site, action } = req.body;
    const cleanSite = path.basename(site);
    if (action === 'stop') {
        exec(`rm -f /etc/nginx/sites-enabled/${cleanSite}`, (err) => {
            if (err) return res.status(500).json({error: err.message});
            exec('systemctl reload nginx', () => res.json({success: true}));
        });
    } else if (action === 'start') {
        exec(`ln -sf /etc/nginx/sites-available/${cleanSite} /etc/nginx/sites-enabled/${cleanSite}`, (err) => {
            if (err) return res.status(500).json({error: err.message});
            exec('systemctl reload nginx', () => res.json({success: true}));
        });
    } else {
        res.status(400).json({error: 'Invalid Action'});
    }
});

// SSL Controls
app.post('/api/nginx/ssl', (req, res) => {
    const { domain } = req.body;
    if (!domain || typeof domain !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
        return res.status(400).json({ error: 'Invalid domain name format.' });
    }
    const cmd = `certbot --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email`;
    exec(cmd, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: err.message, logs: stdout + '\n' + stderr });
        }
        res.json({ success: true, logs: stdout });
    });
});

// File Manager Controls
const BASE_DIR = '/var/www';
app.get('/api/files', (req, res) => {
    const targetPath = path.resolve(req.query.path || BASE_DIR);
    if (!targetPath.startsWith(BASE_DIR)) return res.status(403).json({error: 'Access denied'});
    
    fs.readdir(targetPath, { withFileTypes: true }, (err, files) => {
        if (err) return res.status(500).json({error: err.message});
        
        let result = [];
        if (targetPath !== BASE_DIR) {
            result.push({ name: '..', isDir: true, path: path.dirname(targetPath) });
        }
        
        files.forEach(f => {
            result.push({
                name: f.name,
                isDir: f.isDirectory(),
                path: path.join(targetPath, f.name),
                size: f.isDirectory() ? '-' : fs.statSync(path.join(targetPath, f.name)).size
            });
        });
        
        result.sort((a,b) => {
            if (a.name === '..') return -1;
            if (b.name === '..') return 1;
            if (a.isDir === b.isDir) return a.name.localeCompare(b.name);
            return a.isDir ? -1 : 1;
        });
        res.json({ currentPath: targetPath, files: result });
    });
});
app.get('/api/files/read', (req, res) => {
    const targetPath = path.resolve(req.query.path);
    if (!targetPath.startsWith(BASE_DIR)) return res.status(403).json({error: 'Access denied'});
    fs.readFile(targetPath, 'utf8', (err, data) => res.json({ content: err ? err.message : data }));
});
app.post('/api/files/save', (req, res) => {
    const targetPath = path.resolve(req.body.path);
    if (!targetPath.startsWith(BASE_DIR)) return res.status(403).json({error: 'Access denied'});
    fs.writeFile(targetPath, req.body.content || '', (err) => {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/files/upload', upload.single('siteFile'), (req, res) => {
    const targetPath = path.resolve(req.body.path || BASE_DIR);
    if (!targetPath.startsWith(BASE_DIR)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({error: 'Access denied'});
    }
    
    if (!req.file) return res.status(400).json({error: 'No file uploaded'});

    if (req.file.originalname.toLowerCase().endsWith('.zip')) {
        try {
            const zip = new AdmZip(req.file.path);
            zip.extractAllTo(targetPath, true);
            fs.unlinkSync(req.file.path);
            res.json({success: true, message: 'Website extracted successfully to ' + targetPath + '!'});
        } catch (e) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(500).json({error: 'Failed to extract zip: ' + e.message});
        }
    } else {
        try {
            const finalPath = path.join(targetPath, req.file.originalname);
            fs.copyFileSync(req.file.path, finalPath);
            fs.unlinkSync(req.file.path);
            res.json({success: true, message: 'File uploaded successfully to ' + targetPath + '!'});
        } catch (err) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(500).json({error: 'Failed to move file ' + err.message});
        }
    }
});

app.post('/api/server/restart', (req, res) => {
    res.json({ success: true, message: 'Server restarting...' });
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

app.listen(9000, () => console.log('VPS Dashboard running on 9000'));
