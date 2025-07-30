const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 8080;

// ScraperAPI configuration
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || 'd32b11d359813d5ed5c519bfbdec6f23';
const PROXY_URL = `http://scraperapi:${SCRAPERAPI_KEY}@proxy-server.scraperapi.com:8001`;

// Rate limiting configuration
const REQUEST_DELAY = 3000; // 3 seconds between requests
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds between retries

// Request queue to prevent overwhelming the API
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastRequestTime = 0;
  }

  async add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const { requestFn, resolve, reject } = this.queue.shift();
      
      try {
        // Ensure minimum delay between requests
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < REQUEST_DELAY) {
          await new Promise(r => setTimeout(r, REQUEST_DELAY - timeSinceLastRequest));
        }
        
        const result = await requestFn();
        this.lastRequestTime = Date.now();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      
      // Small delay between queue items
      await new Promise(r => setTimeout(r, 1000));
    }
    
    this.processing = false;
  }
}

const requestQueue = new RequestQueue();

// Middleware
app.use(express.json());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://vibedownloader.vercel.app',
    'https://vibedownloader.me',
    'https://www.vibedownloader.me',
    'https://ytapi.vibedownloader.me'
  ]
}));

// Configuration
const DOWNLOAD_FOLDER = path.join(process.cwd(), 'downloads');
const TEMP_FOLDER = path.join(process.cwd(), 'temp');

// Create directories
const createDirectories = async () => {
  try {
    await fs.mkdir(DOWNLOAD_FOLDER, { recursive: true });
    await fs.mkdir(TEMP_FOLDER, { recursive: true });
  } catch (error) {
    console.error('Error creating directories:', error);
  }
};

// Storage for download progress and completed downloads
const downloadsInProgress = new Map();
const completedDownloads = new Map();

// Cleanup function (same as before)
const cleanupOldFiles = async () => {
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;

  try {
    const downloadFiles = await fs.readdir(DOWNLOAD_FOLDER);
    for (const file of downloadFiles) {
      const filePath = path.join(DOWNLOAD_FOLDER, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > twoHours) {
        await fs.unlink(filePath);
        console.log(`Deleted old file: ${file}`);
      }
    }

    const tempFiles = await fs.readdir(TEMP_FOLDER);
    for (const file of tempFiles) {
      const filePath = path.join(TEMP_FOLDER, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > twoHours) {
        await fs.unlink(filePath);
      }
    }

    for (const [id, info] of completedDownloads.entries()) {
      if (now - info.completionTime > twoHours) {
        completedDownloads.delete(id);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
};

setInterval(cleanupOldFiles, 60 * 60 * 1000);

// Improved proxy request with better error handling and retries
const makeScraperAPIRequest = async (url, retryCount = 0) => {
  try {
    console.log(`Making ScraperAPI request (attempt ${retryCount + 1}):`, url);
    
    // Use ScraperAPI's API endpoint with better parameters
    const scraperApiUrl = new URL('http://api.scraperapi.com/');
    scraperApiUrl.searchParams.set('api_key', SCRAPERAPI_KEY);
    scraperApiUrl.searchParams.set('url', url);
    scraperApiUrl.searchParams.set('render', 'false');
    scraperApiUrl.searchParams.set('country_code', 'us');
    scraperApiUrl.searchParams.set('premium', 'true'); // Use premium if available
    scraperApiUrl.searchParams.set('session_number', Math.floor(Math.random() * 100)); // Random session
    
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, 45000); // 45 second timeout
      
      const request = http.request(scraperApiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }, (res) => {
        clearTimeout(timeout);
        resolve(res);
      });
      
      request.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      
      request.end();
    });

    let data = '';
    response.on('data', chunk => data += chunk);
    
    await new Promise((resolve, reject) => {
      response.on('end', resolve);
      response.on('error', reject);
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      console.log(`ScraperAPI request successful (${response.statusCode})`);
      return data;
    } else if (response.statusCode === 429 && retryCount < MAX_RETRIES) {
      // Rate limited, wait and retry
      console.log(`Rate limited (429), retrying in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
      return makeScraperAPIRequest(url, retryCount + 1);
    } else {
      throw new Error(`HTTP ${response.statusCode}: ${data}`);
    }
  } catch (error) {
    if (retryCount < MAX_RETRIES && !error.message.includes('timeout')) {
      console.log(`Request failed, retrying in ${RETRY_DELAY}ms:`, error.message);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
      return makeScraperAPIRequest(url, retryCount + 1);
    }
    
    console.error('ScraperAPI request failed after retries:', error.message);
    throw error;
  }
};

// Alternative method using different approach
const makeAlternativeRequest = async (url) => {
  try {
    // Use different ScraperAPI endpoint
    const response = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}&render=false&country_code=us&premium=true`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 30000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    return await response.text();
  } catch (error) {
    console.error('Alternative request failed:', error.message);
    throw error;
  }
};

// Custom fetch function with multiple fallback strategies
const customFetch = async (url, options = {}) => {
  try {
    // First try: ScraperAPI with retries
    return await makeScraperAPIRequest(url);
  } catch (error) {
    console.log('Primary ScraperAPI failed, trying alternative approach...');
    
    try {
      // Second try: Alternative ScraperAPI method
      return await makeAlternativeRequest(url);
    } catch (altError) {
      console.log('Alternative method failed, using direct request with delay...');
      
      // Third try: Direct request with long delay (last resort)
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.youtube.com/',
          'Origin': 'https://www.youtube.com'
        },
        timeout: 20000
      });
      
      if (!response.ok) {
        throw new Error(`Direct request failed: HTTP ${response.status}`);
      }
      
      return await response.text();
    }
  }
};

// Create multiple ytdl agents with different configurations
const createYtdlAgents = () => {
  const agents = [];
  
  // Agent 1: Basic configuration
  agents.push(ytdl.createAgent([
    {
      "name": "VISITOR_INFO1_LIVE",
      "value": "st1td6w_9rslsToken"
    }
  ], {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }));
  
  // Agent 2: Different session
  agents.push(ytdl.createAgent([
    {
      "name": "VISITOR_INFO1_LIVE",
      "value": "st2td7w_8rslsToken"
    }
  ], {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }));
  
  return agents;
};

// Override ytdl's request function to use our custom fetch
const originalRequest = require('@distube/ytdl-core/lib/utils').request;
require('@distube/ytdl-core/lib/utils').request = async (url, options = {}) => {
  try {
    // Only proxy YouTube requests
    if (url.includes('youtube.com') || url.includes('googlevideo.com')) {
      return await requestQueue.add(() => customFetch(url, options));
    } else {
      return originalRequest(url, options);
    }
  } catch (error) {
    console.error('Custom request failed:', error.message);
    // Don't fallback to original for YouTube URLs as it will likely fail too
    throw error;
  }
};

// Improved video info function with better error handling
const getVideoInfo = async (url) => {
  const agents = createYtdlAgents();
  let lastError;
  
  // Try with different agents
  for (let i = 0; i < agents.length; i++) {
    try {
      console.log(`Attempting to get video info with agent ${i + 1}...`);
      
      // Add random delay to avoid patterns
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
      
      const info = await ytdl.getInfo(url, { 
        agent: agents[i],
        requestOptions: {
          headers: {
            'User-Agent': agents[i].jar._jar.store.idx['youtube.com']['/'].VISITOR_INFO1_LIVE ? 
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' :
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      });
      
      const videoDetails = info.videoDetails;
      const formats = info.formats;

      // Filter and map audio formats
      const audioFormats = formats
        .filter(format => format.hasAudio && !format.hasVideo && format.audioBitrate)
        .map(format => ({
          format_id: format.itag.toString(),
          ext: format.container,
          format_note: `${format.audioBitrate}kbps`,
          abr: format.audioBitrate,
          filesize: format.contentLength ? parseInt(format.contentLength) : null,
          download_url: `/api/direct-download/${videoDetails.videoId}/${format.itag}`
        }))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));

      // Filter and map video formats
      const videoFormats = formats
        .filter(format => format.hasVideo && format.height)
        .map(format => ({
          format_id: format.itag.toString(),
          ext: format.container,
          format_note: format.qualityLabel || `${format.height}p`,
          width: format.width,
          height: format.height,
          fps: format.fps,
          vcodec: format.videoCodec,
          acodec: format.hasAudio ? format.audioCodec : 'none',
          filesize: format.contentLength ? parseInt(format.contentLength) : null,
          download_url: `/api/direct-download/${videoDetails.videoId}/${format.itag}`,
          resolution: `${format.width}x${format.height}`
        }))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      return {
        id: videoDetails.videoId,
        title: videoDetails.title,
        description: videoDetails.description,
        duration: parseInt(videoDetails.lengthSeconds),
        view_count: parseInt(videoDetails.viewCount),
        upload_date: videoDetails.uploadDate,
        thumbnails: videoDetails.thumbnails.map(thumb => ({
          url: thumb.url,
          width: thumb.width,
          height: thumb.height
        })),
        channel: {
          id: videoDetails.channelId,
          name: videoDetails.author,
          url: `https://www.youtube.com/channel/${videoDetails.channelId}`,
          verified: videoDetails.author?.verified || false
        },
        audio_formats: audioFormats,
        video_formats: videoFormats
      };
    } catch (error) {
      console.error(`Agent ${i + 1} failed:`, error.message);
      lastError = error;
      
      // If rate limited, wait longer before trying next agent
      if (error.message.includes('429') || error.message.includes('rate')) {
        console.log('Rate limited, waiting 10 seconds before next attempt...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
  
  throw new Error(`All agents failed. Last error: ${lastError?.message || 'Unknown error'}`);
};

// Routes

// Health check with improved proxy testing
app.get('/api/health', async (req, res) => {
  try {
    let proxyWorking = false;
    let proxyError = null;
    
    try {
      const testUrl = 'https://www.youtube.com';
      await customFetch(testUrl);
      proxyWorking = true;
    } catch (error) {
      proxyError = error.message;
      console.error('Proxy test failed:', error.message);
    }

    res.json({
      status: 'ok',
      version: '2.1.0',
      proxyEnabled: !!SCRAPERAPI_KEY,
      proxyWorking,
      proxyError,
      queueLength: requestQueue.queue.length,
      platform: 'nodejs'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get video information with improved error handling
app.get('/api/video-info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing video URL' });
  }

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const videoInfo = await getVideoInfo(url);
    res.json(videoInfo);
  } catch (error) {
    console.error('Video info endpoint error:', error);
    
    // Provide more specific error messages
    let errorMessage = error.message;
    if (error.message.includes('429')) {
      errorMessage = 'YouTube is currently rate limiting requests. Please try again in a few minutes.';
    } else if (error.message.includes('403')) {
      errorMessage = 'Access forbidden. The video might be private or restricted.';
    } else if (error.message.includes('404')) {
      errorMessage = 'Video not found. Please check the URL.';
    }
    
    res.status(500).json({ 
      error: errorMessage,
      retryAfter: error.message.includes('429') ? 300 : null // 5 minutes
    });
  }
});

// Start download (rest of the endpoints remain the same but use the improved getVideoInfo)
app.get('/api/download', async (req, res) => {
  const { url, format_id } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing video URL' });
  }

  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const downloadId = uuidv4();

  // Start download in background
  processDownload(downloadId, url, format_id);

  res.json({
    downloadId,
    status: 'processing',
    message: 'Download started. Check status using the /api/download-status endpoint.'
  });
});

// Process download function (updated to use new getVideoInfo)
const processDownload = async (downloadId, url, formatId) => {
  downloadsInProgress.set(downloadId, {
    status: 'downloading',
    progress: 0,
    url,
    startTime: Date.now()
  });

  try {
    const agents = createYtdlAgents();
    let info;
    
    // Try to get info with different agents
    for (const agent of agents) {
      try {
        await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        info = await ytdl.getInfo(url, { 
          agent,
          requestOptions: {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          }
        });
        break;
      } catch (error) {
        console.error('Failed to get info with agent, trying next...', error.message);
      }
    }
    
    if (!info) {
      throw new Error('Failed to get video info with all agents');
    }
    
    const videoDetails = info.videoDetails;
    const title = videoDetails.title.replace(/[^\w\s-]/g, '').trim();
    const outputPath = path.join(DOWNLOAD_FOLDER, `${downloadId}_${title}.mp4`);

    // Get best video and audio formats
    const videoFormat = formatId ? 
      info.formats.find(f => f.itag.toString() === formatId) :
      ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
    
    const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

    if (!videoFormat || !audioFormat) {
      throw new Error('Could not find suitable video or audio format');
    }

    // Use the first working agent for download
    const workingAgent = agents[0];

    // If video format has audio, just download it directly
    if (videoFormat.hasAudio) {
      const stream = ytdl(url, { 
        format: videoFormat, 
        agent: workingAgent,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      });
      const writeStream = require('fs').createWriteStream(outputPath);

      let downloadedBytes = 0;
      const totalBytes = parseInt(videoFormat.contentLength) || 0;

      stream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const progress = Math.round((downloadedBytes / totalBytes) * 100);
          const downloadInfo = downloadsInProgress.get(downloadId);
          if (downloadInfo) {
            downloadInfo.progress = progress;
          }
        }
      });

      stream.on('error', (error) => {
        console.error('Download error:', error);
        downloadsInProgress.delete(downloadId);
        completedDownloads.set(downloadId, {
          status: 'failed',
          url,
          error: error.message,
          completionTime: Date.now()
        });
      });

      stream.pipe(writeStream);

      writeStream.on('finish', () => {
        downloadsInProgress.delete(downloadId);
        completedDownloads.set(downloadId, {
          status: 'completed',
          url,
          filePath: outputPath,
          downloadUrl: `/api/get-file/${downloadId}`,
          completionTime: Date.now()
        });
      });
    } else {
      // Download video and audio separately, then merge
      const videoPath = path.join(TEMP_FOLDER, `${downloadId}_video.${videoFormat.container}`);
      const audioPath = path.join(TEMP_FOLDER, `${downloadId}_audio.${audioFormat.container}`);

      // Update status
      const downloadInfo = downloadsInProgress.get(downloadId);
      if (downloadInfo) downloadInfo.status = 'downloading_video';

      // Download video
      await downloadStream(url, videoFormat, videoPath, downloadId, 'video', workingAgent);

      // Update status
      if (downloadsInProgress.has(downloadId)) {
        downloadsInProgress.get(downloadId).status = 'downloading_audio';
      }

      // Download audio
      await downloadStream(url, audioFormat, audioPath, downloadId, 'audio', workingAgent);

      // Update status
      if (downloadsInProgress.has(downloadId)) {
        downloadsInProgress.get(downloadId).status = 'merging';
        downloadsInProgress.get(downloadId).progress = 90;
      }

      // Merge video and audio
      await mergeVideoAudio(videoPath, audioPath, outputPath);

      // Clean up temp files
      try {
        await fs.unlink(videoPath);
        await fs.unlink(audioPath);
      } catch (err) {
        console.error('Error cleaning temp files:', err);
      }

      downloadsInProgress.delete(downloadId);
      completedDownloads.set(downloadId, {
        status: 'completed',
        url,
        filePath: outputPath,
        downloadUrl: `/api/get-file/${downloadId}`,
        completionTime: Date.now()
      });
    }

  } catch (error) {
    console.error('Process download error:', error);
    downloadsInProgress.delete(downloadId);
    completedDownloads.set(downloadId, {
      status: 'failed',
      url,
      error: error.message,
      completionTime: Date.now()
    });
  }
};

// Helper function to download stream to file (same as before)
const downloadStream = (url, format, outputPath, downloadId, type, agent) => {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, { 
      format, 
      agent,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }
    });
    const writeStream = require('fs').createWriteStream(outputPath);

    let downloadedBytes = 0;
    const totalBytes = parseInt(format.contentLength) || 0;

    stream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0 && downloadsInProgress.has(downloadId)) {
        const progress = Math.round((downloadedBytes / totalBytes) * (type === 'video' ? 40 : 80));
        const downloadInfo = downloadsInProgress.get(downloadId);
        if (downloadInfo) {
          downloadInfo.progress = Math.min(progress + (type === 'audio' ? 40 : 0), 85);
        }
      }
    });

    stream.on('error', reject);
    stream.pipe(writeStream);

    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
};

// Helper function to merge video and audio using ffmpeg (same as before)
const mergeVideoAudio = (videoPath, audioPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-strict experimental'
      ])
      .output(outputPath)
      .on('end', () => {
        console.log('Merging finished successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('Error during merging:', err);
        reject(err);
      })
      .run();
  });
};

// Rest of the endpoints remain the same...
app.get('/api/download-status/:downloadId', (req, res) => {
  const { downloadId } = req.params;

  if (downloadsInProgress.has(downloadId)) {
    const info = downloadsInProgress.get(downloadId);
    return res.json({
      downloadId,
      status: info.status,
      progress: info.progress,
      url: info.url
    });
  }

  if (completedDownloads.has(downloadId)) {
    const info = completedDownloads.get(downloadId);
    return res.json({
      downloadId,
      status: info.status,
      url: info.url,
      downloadUrl: info.downloadUrl,
      error: info.error
    });
  }

  res.status(404).json({ error: 'Download ID not found' });
});

app.get('/api/get-file/:downloadId', async (req, res) => {
  const { downloadId } = req.params;

  if (!completedDownloads.has(downloadId)) {
    return res.status(404).json({ error: 'Download not found' });
  }

  const downloadInfo = completedDownloads.get(downloadId);
  
  if (downloadInfo.status !== 'completed') {
    return res.status(404).json({ error: 'Download not completed' });
  }

  try {
    await fs.access(downloadInfo.filePath);
    const filename = path.basename(downloadInfo.filePath);
    res.download(downloadInfo.filePath, filename);
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

// Direct download endpoint (updated with improved error handling)
app.get('/api/direct-download/:videoId/:formatId', async (req, res) => {
  const { videoId, formatId } = req.params;
  const { filename } = req.query;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

      try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    // Add delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));

    const agents = createYtdlAgents();
    let info;
    
    // Try with different agents
    for (const agent of agents) {
      try {
        info = await ytdl.getInfo(url, { 
          agent,
          requestOptions: {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          }
        });
        break;
      } catch (error) {
        console.error('Agent failed for direct download, trying next...', error.message);
      }
    }
    
    if (!info) {
      return res.status(500).json({ error: 'Failed to get video info with all agents' });
    }
    
    const videoDetails = info.videoDetails;
    const title = videoDetails.title.replace(/[^\w\s-]/g, '').trim();
    
    const downloadName = filename || `${title}.mp4`;

    // Find the requested format
    const requestedFormat = info.formats.find(f => f.itag.toString() === formatId);
    
    if (!requestedFormat) {
      return res.status(404).json({ error: 'Format not found' });
    }

    // Use the first working agent
    const workingAgent = agents[0];

    // If format has audio, stream directly
    if (requestedFormat.hasAudio) {
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Type', 'video/mp4');

      const stream = ytdl(url, { 
        format: requestedFormat,
        agent: workingAgent,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      });

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
      });

      stream.pipe(res);
    } else {
      // Format doesn't have audio, need to merge with best audio
      const tempId = uuidv4();
      const videoPath = path.join(TEMP_FOLDER, `${tempId}_video.${requestedFormat.container}`);
      const audioPath = path.join(TEMP_FOLDER, `${tempId}_audio.webm`);

      try {
        // Get best audio format
        const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
        
        if (!audioFormat) {
          return res.status(500).json({ error: 'No audio format available' });
        }

        // Download video and audio
        await Promise.all([
          downloadToFile(url, requestedFormat, videoPath, workingAgent),
          downloadToFile(url, audioFormat, audioPath, workingAgent)
        ]);

        // Merge and stream the result
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        res.setHeader('Content-Type', 'video/mp4');

        const ffmpegProcess = ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-strict experimental',
            '-movflags frag_keyframe+empty_moov'
          ])
          .format('mp4')
          .on('end', () => {
            // Clean up temp files
            fs.unlink(videoPath).catch(console.error);
            fs.unlink(audioPath).catch(console.error);
          })
          .on('error', (err) => {
            console.error('FFmpeg error:', err);
            // Clean up temp files
            fs.unlink(videoPath).catch(console.error);
            fs.unlink(audioPath).catch(console.error);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Merge failed' });
            }
          });

        ffmpegProcess.pipe(res);

      } catch (error) {
        // Clean up any temp files
        fs.unlink(videoPath).catch(console.error);
        fs.unlink(audioPath).catch(console.error);
        throw error;
      }
    }

  } catch (error) {
    console.error('Direct download error:', error);
    if (!res.headersSent) {
      // Provide more specific error messages
      let errorMessage = error.message;
      if (error.message.includes('429')) {
        errorMessage = 'YouTube is currently rate limiting requests. Please try again in a few minutes.';
      } else if (error.message.includes('403')) {
        errorMessage = 'Access forbidden. The video might be private or restricted.';
      }
      
      res.status(500).json({ error: errorMessage });
    }
  }
});

// Helper function to download stream to file (updated)
const downloadToFile = (url, format, outputPath, agent) => {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, { 
      format, 
      agent,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }
    });
    const writeStream = require('fs').createWriteStream(outputPath);

    stream.on('error', reject);
    stream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
};

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Set environment variable to disable ytdl update check
process.env.YTDL_NO_UPDATE = '1';

// Add process handlers for graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Initialize directories and start server
const startServer = async () => {
  await createDirectories();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`YouTube Downloader API running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`Proxy enabled: ${!!SCRAPERAPI_KEY}`);
    console.log(`YTDL_NO_UPDATE set to disable update checks`);
    console.log(`Request queue system active`);
    console.log(`Rate limiting: ${REQUEST_DELAY}ms between requests`);
  });
};

startServer().catch(console.error);
