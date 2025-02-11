import express from 'express';
import WikimediaStream from 'wikimedia-streams';
import fetch from 'node-fetch';

const app = express();
const port = 3000;

// Initialize the Wikimedia stream
const stream = new WikimediaStream("recentchange");

// Store recent changes in memory (limited to last 100 changes)
const recentChanges = [];
const MAX_CHANGES = 100;

// Helper function to clean up diff HTML using regex
function cleanDiffHtml(diffHtml) {
    if (!diffHtml) return null;  // Changed from 'No changes found' to null
    
    // Simple regex to extract text between tags
    const addedText = diffHtml.match(/<ins[^>]*>(.*?)<\/ins>/g) || [];
    const deletedText = diffHtml.match(/<del[^>]*>(.*?)<\/del>/g) || [];
    
    // Clean up the matches
    const additions = addedText.map(text => 
        text.replace(/<[^>]+>/g, '').trim()
    ).filter(text => text.length > 0);
    
    const deletions = deletedText.map(text => 
        text.replace(/<[^>]+>/g, '').trim()
    ).filter(text => text.length > 0);
    
    // Only return diff if there are actual changes
    if (additions.length === 0 && deletions.length === 0) {
        return null;  // Return null for minor changes
    }
    
    // Format the changes in a readable way
    let readableDiff = '';
    if (deletions.length) {
        readableDiff += `<del>${deletions.join(' ')}</del>`;
    }
    if (additions.length) {
        if (readableDiff) readableDiff += '<br>';
        readableDiff += `<ins>${additions.join(' ')}</ins>`;
    }
    
    return readableDiff;
}

// Modify the stream listener
stream.on("recentchange", async (data, event) => {
    if (data.wiki === "enwiki" && 
        data.namespace === 0 && 
        data.type !== 'log' && 
        !data.title.includes('Page log')) {
        try {
            if (data.type === 'new') {  // Handle new pages first
                const change = {
                    title: data.title,
                    timestamp: new Date(data.meta.dt).toLocaleString(),
                    isNew: true  // Add flag for new pages
                };
                recentChanges.unshift(change);
            } else if (data.revision && data.revision.old && data.revision.new) {
                const response = await fetch(
                    `https://en.wikipedia.org/w/api.php?` +
                    `action=compare&fromrev=${data.revision.old}&torev=${data.revision.new}` +
                    `&format=json&origin=*&prop=diff|diffsize|rel|ids|title|user|comment|parsedcomment|size`
                );
                const diffData = await response.json();
                
                const diff = cleanDiffHtml(diffData.compare['*']);
                if (diff) {  // Only add to changes if there's actual content
                    const change = {
                        title: data.title,
                        timestamp: new Date(data.meta.dt).toLocaleString(),
                        diff: diff
                    };
                    recentChanges.unshift(change);
                }
            } else if (data.type === 'delete') {
                // Still show deletions
                const change = {
                    title: data.title,
                    timestamp: new Date(data.meta.dt).toLocaleString(),
                    diff: 'Page deleted'
                };
                recentChanges.unshift(change);
            }
            
            if (recentChanges.length > MAX_CHANGES) {
                recentChanges.pop();
            }
        } catch (error) {
            console.error('Error processing change:', error);
        }
    }
});

// Serve static HTML
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: '.' });
});

// SSE endpoint
app.get('/changes', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send all existing changes immediately
    res.write(`data: ${JSON.stringify(recentChanges)}\n\n`);

    // Send new changes as they come in
    const sendChange = async (data) => {
        try {
            let change;
            if (data.type === 'new') {  // Handle new pages first
                change = {
                    title: data.title,
                    timestamp: new Date(data.meta.dt).toLocaleString(),
                    isNew: true
                };
                res.write(`data: ${JSON.stringify([change])}\n\n`);
            } else if (data.revision && data.revision.old && data.revision.new) {
                const response = await fetch(
                    `https://en.wikipedia.org/w/api.php?` +
                    `action=compare&fromrev=${data.revision.old}&torev=${data.revision.new}` +
                    `&format=json&origin=*&prop=diff|diffsize|rel|ids|title|user|comment|parsedcomment|size`
                );
                const diffData = await response.json();
                
                const diff = cleanDiffHtml(diffData.compare['*']);
                // Only send if we have actual changes
                if (diff) {
                    change = {
                        title: data.title,
                        timestamp: new Date(data.meta.dt).toLocaleString(),
                        diff: diff
                    };
                    res.write(`data: ${JSON.stringify([change])}\n\n`);
                }
            } else if (data.type === 'delete') {
                change = {
                    title: data.title,
                    timestamp: new Date(data.meta.dt).toLocaleString(),
                    diff: 'Page deleted'
                };
                res.write(`data: ${JSON.stringify([change])}\n\n`);
            }
        } catch (error) {
            console.error('Error in sendChange:', error);
        }
    };

    stream.on("recentchange", (data, event) => {
        if (data.wiki === "enwiki" && 
            data.namespace === 0 && 
            data.type !== 'log' &&  // Add this condition
            !data.title.includes('Page log')) {  // Add this condition
            sendChange(data);
        }
    });

    // Handle client disconnect
    req.on('close', () => {
        stream.removeListener("recentchange", sendChange);
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

// Error handling for the stream
stream.on('error', (error) => {
    console.error('Stream error:', error);
}); 