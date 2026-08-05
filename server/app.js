const express = require('express');
const Traceroute = require('nodejs-traceroute');
const geoip = require('geoip-lite');
const path = require('path');

const app = express();
const PORT = 3000;

// 1. Serve the frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, '../public')));

// 2. Create the API endpoint that executes the traceroute
app.get('/api/trace/:domain', (req, res) => {
    const targetDomain = req.params.domain;
    const activeHops = [];

    try {
        const tracer = new Traceroute();

        // 3. Listen for each hop as it happens
        tracer.on('hop', (hop) => {
            // Ignore timeouts (*) and local/private network IPs that have no GPS data
            if (hop.ip && hop.ip !== '*') {
                const geoData = geoip.lookup(hop.ip);
                
                // If the IP is public and exists in the database, save it
                if (geoData && geoData.ll) {
                    activeHops.push({
                        hopNumber: hop.hop,
                        ip: hop.ip,
                        lat: geoData.ll[0], // Latitude
                        lng: geoData.ll[1], // Longitude
                        city: geoData.city,
                        country: geoData.country
                    });
                    console.log(`Discovered: ${hop.ip} in ${geoData.city || 'Unknown'}`);
                }
            }
        });

        // 4. When the trace finishes, format the arcs and send the response
        tracer.on('close', (code) => {
            console.log(`Trace to ${targetDomain} complete.`);
            
            const arcs = [];
            // Create a pair connecting hop 1 to hop 2, hop 2 to hop 3, etc.
            for (let i = 0; i < activeHops.length - 1; i++) {
                arcs.push({
                    startLat: activeHops[i].lat,
                    startLng: activeHops[i].lng,
                    endLat: activeHops[i + 1].lat,
                    endLng: activeHops[i + 1].lng,
                    color: 'cyan'
                });
            }
            
            // Send both the raw points and the formatted arcs to the frontend
            res.json({ points: activeHops, arcs: arcs });
        });

        tracer.on('error', (err) => {
            console.error('Traceroute error:', err);
            res.status(500).json({ error: 'Failed to execute traceroute' });
        });

        // 5. Start the engine
        console.log(`Starting trace to ${targetDomain}...`);
        tracer.trace(targetDomain);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is live! Visit http://localhost:${PORT}`);
});