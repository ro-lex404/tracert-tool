const express = require('express');
const { spawn } = require('child_process');
const { Reader } = require('@maxmind/geoip2-node');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, '../public')));

let cityLookup = null;
let asnLookup = null;

Promise.all([
    Reader.open(path.join(__dirname, '../data/GeoLite2-City.mmdb')),
    Reader.open(path.join(__dirname, '../data/GeoLite2-ASN.mmdb'))
]).then(([cityReader, asnReader]) => {
    cityLookup = cityReader;
    asnLookup = asnReader;
    console.log('MaxMind Databases loaded.');
}).catch(err => console.error('DB Load Error:', err));

app.get('/api/trace/:domain', (req, res) => {
    const targetDomain = req.params.domain;
    const activeHops = [];
    
    if (!cityLookup) return res.status(500).json({ error: 'DB not ready' });

    // 1. Configure the native system command based on the OS
    const isWindows = os.platform() === 'win32';
    // Windows tracert doesn't easily support UDP/TCP out of the box, so we use defaults.
    // macOS/Linux supports the -I (ICMP) or -U (UDP) flags which bypass many firewalls.
    const cmd = isWindows ? 'tracert' : 'traceroute';
    const args = isWindows ? ['-d', '-w', '1000', targetDomain] : ['-q', '1', '-w', '1', targetDomain];

    console.log(`Executing: ${cmd} ${args.join(' ')}`);
    const traceProcess = spawn(cmd, args);

    // 2. Parse the raw text output stream manually
    traceProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        
        for (const line of lines) {
            // Regex to extract an IP address from a line of text
            const ipMatch = line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
            const hopMatch = line.trim().match(/^(\d+)/); // Extract the hop number at the start of the line

            if (ipMatch && hopMatch) {
                const ip = ipMatch[0];
                const hopNum = parseInt(hopMatch[1], 10);

                // Ignore local/private IPs immediately
                if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) continue;

                try {
                    const geoData = cityLookup.city(ip);
                    const asnData = asnLookup.asn(ip);
                    
                    // 3. The Fix: Fallback to country coordinates if city coordinates are missing
                    let lat = geoData?.location?.latitude;
                    let lng = geoData?.location?.longitude;
                    
                    if (!lat || !lng) {
                       // If we know the country but not the city, we use the country object's rough coordinates if available
                       lat = geoData?.country?.location?.latitude || null;
                       lng = geoData?.country?.location?.longitude || null;
                    }

                    if (lat !== null && lng !== null) {
                        // Check if we already logged this hop (to prevent duplicates from weird routing)
                        if (!activeHops.find(h => h.ip === ip)) {
                            activeHops.push({
                                hopNumber: hopNum,
                                ip: ip,
                                lat: lat,
                                lng: lng,
                                city: geoData?.city?.names?.en || geoData?.country?.names?.en || 'Unknown Region',
                                country: geoData?.country?.isoCode || 'Unk',
                                isp: asnData?.autonomousSystemOrganization || 'Unknown ISP'
                            });
                            console.log(`Hop ${hopNum}: ${ip} -> ${activeHops[activeHops.length-1].city}`);
                        }
                    }
                } catch (e) {
                    // IP not in database
                }
            }
        }
    });

    traceProcess.on('close', (code) => {
        console.log(`Trace complete.`);
        
        // 4. Sort hops numerically in case the async stream arrived out of order
        activeHops.sort((a, b) => a.hopNumber - b.hopNumber);

        const arcs = [];
        for (let i = 0; i < activeHops.length - 1; i++) {
            // 5. Do not draw arcs if the start and end coordinates are identical
            if (activeHops[i].lat !== activeHops[i+1].lat || activeHops[i].lng !== activeHops[i+1].lng) {
                arcs.push({
                    startLat: activeHops[i].lat,
                    startLng: activeHops[i].lng,
                    endLat: activeHops[i + 1].lat,
                    endLng: activeHops[i + 1].lng,
                    color: 'cyan'
                });
            }
        }
        
        res.json({ points: activeHops, arcs: arcs });
    });

    traceProcess.on('error', (err) => {
        console.error('Failed to start process:', err);
        res.status(500).json({ error: 'System command failed' });
    });
});

app.listen(PORT, () => {
    console.log(`Server live on http://localhost:${PORT}`);
});