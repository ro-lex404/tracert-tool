const express = require('express');
const Traceroute = require('nodejs-traceroute');
const { Reader } = require('@maxmind/geoip2-node');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, '../public')));

// 1. Load the MaxMind Database into memory on startup
// 1. Set up variables for both databases
let cityLookup = null;
let asnLookup = null;

// 2. Load both databases concurrently
Promise.all([
    Reader.open(path.join(__dirname, '../data/GeoLite2-City.mmdb')),
    Reader.open(path.join(__dirname, '../data/GeoLite2-ASN.mmdb'))
]).then(([cityReader, asnReader]) => {
    cityLookup = cityReader;
    asnLookup = asnReader;
    console.log('Both MaxMind Databases (City & ASN) loaded successfully.');
}).catch(err => {
    console.error('Failed to load MaxMind databases. Check your data folder.', err);
});


app.get('/api/trace/:domain', (req, res) => {
    const targetDomain = req.params.domain;
    const activeHops = [];

    if (!cityLookup) {
        return res.status(500).json({ error: 'Database not initialized yet.' });
    }

    try {
        const tracer = new Traceroute();

        tracer.on('hop', (hop) => {
            if (hop.ip && hop.ip !== '*') {
                try {
                    // Query the City DB for Geography
                    const geoData = cityLookup.city(hop.ip);
                    // Query the ASN DB for the Organization
                    const asnData = asnLookup.asn(hop.ip);
                    
                    if (geoData && geoData.location) {
                        activeHops.push({
                            hopNumber: hop.hop,
                            ip: hop.ip,
                            lat: geoData.location.latitude,
                            lng: geoData.location.longitude,
                            city: geoData.city && geoData.city.names ? geoData.city.names.en : 'Unknown City',
                            country: geoData.country && geoData.country.isoCode ? geoData.country.isoCode : 'Unknown',
                            // Add the organization name! Fallback to 'Unknown ISP' if not found.
                            isp: asnData && asnData.autonomousSystemOrganization ? asnData.autonomousSystemOrganization : 'Unknown ISP'
                        });
                        
                        console.log(`Discovered: ${hop.ip} in ${activeHops[activeHops.length-1].city} (${activeHops[activeHops.length-1].isp})`);
                    }
                } catch (e) {
                    // Ignore local IPs or IPs not in the database
                }
            }
        });

        tracer.on('close', (code) => {
            console.log(`Trace to ${targetDomain} complete.`);
            
            const arcs = [];
            for (let i = 0; i < activeHops.length - 1; i++) {
                arcs.push({
                    startLat: activeHops[i].lat,
                    startLng: activeHops[i].lng,
                    endLat: activeHops[i + 1].lat,
                    endLng: activeHops[i + 1].lng,
                    color: 'cyan'
                });
            }
            
            res.json({ points: activeHops, arcs: arcs });
        });

        tracer.on('error', (err) => {
            console.error('Traceroute error:', err);
            res.status(500).json({ error: 'Failed to execute traceroute' });
        });

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