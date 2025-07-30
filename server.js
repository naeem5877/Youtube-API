const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 8080;

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
const COOKIE_FILE = path.join(process.cwd(), 'cookie.txt');

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

// Cleanup function
const cleanupOldFiles = async () => {
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

  try {
    // Clean download folder
    const downloadFiles = await fs.readdir(DOWNLOAD_FOLDER);
    for (const file of downloadFiles) {
      const filePath = path.join(DOWNLOAD_FOLDER, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > twoHours) {
        await fs.unlink(filePath);
        console.log(`Deleted old file: ${file}`);
      }
    }

    // Clean temp folder
    const tempFiles = await fs.readdir(TEMP_FOLDER);
    for (const file of tempFiles) {
      const filePath = path.join(TEMP_FOLDER, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > twoHours) {
        await fs.unlink(filePath);
      }
    }

    // Clean completed downloads map
    for (const [id, info] of completedDownloads.entries()) {
      if (now - info.completionTime > twoHours) {
        completedDownloads.delete(id);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
};

// Run cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

// Create agent with better headers to avoid detection
const agent = ytdl.createAgent([
  {
    "name": "VISITOR_INFO1_LIVE",
    "value": "st1td6w_9rslsToken"
  }
], {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

// Helper function to get video info
const getVideoInfo = async (url) => {
  try {
    const info = await ytdl.getInfo(url, { agent });
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
    console.error('Video info error:', error);
    throw new Error(`Failed to get video info: ${error.message}`);
  }
};

// Routes

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const cookieExists = await fs.access(COOKIE_FILE).then(() => true).catch(() => false);
    res.json({
      status: 'ok',
      version: '2.0.0',
      cookieFileExists: cookieExists,
      platform: 'nodejs'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get video information
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
    res.status(500).json({ error: error.message });
  }
});

// Start download
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

// Process download function
const processDownload = async (downloadId, url, formatId) => {
  downloadsInProgress.set(downloadId, {
    status: 'downloading',
    progress: 0,
    url,
    startTime: Date.now()
  });

  try {
    const info = await ytdl.getInfo(url, { agent });
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

    // If video format has audio, just download it directly
    if (videoFormat.hasAudio) {
      const stream = ytdl(url, { format: videoFormat, agent });
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
      await downloadStream(url, videoFormat, videoPath, downloadId, 'video');

      // Update status
      if (downloadsInProgress.has(downloadId)) {
        downloadsInProgress.get(downloadId).status = 'downloading_audio';
      }

      // Download audio
      await downloadStream(url, audioFormat, audioPath, downloadId, 'audio');

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

// Helper function to download stream to file
const downloadStream = (url, format, outputPath, downloadId, type) => {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, { format, agent });
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

// Helper function to merge video and audio using ffmpeg
const mergeVideoAudio = (videoPath, audioPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',  // Copy video codec (no re-encoding)
        '-c:a aac',   // Convert audio to AAC
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

// Check download status
app.get('/api/download-status/:downloadId', (req, res) => {
  const { downloadId } = req.params;

  // Check if download is in progress
  if (downloadsInProgress.has(downloadId)) {
    const info = downloadsInProgress.get(downloadId);
    return res.json({
      downloadId,
      status: info.status,
      progress: info.progress,
      url: info.url
    });
  }

  // Check if download is completed
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

// Get downloaded file
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

// Direct download endpoint with audio merging
app.get('/api/direct-download/:videoId/:formatId', async (req, res) => {
  const { videoId, formatId } = req.params;
  const { filename } = req.query;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const info = await ytdl.getInfo(url, { agent });
    const videoDetails = info.videoDetails;
    const title = videoDetails.title.replace(/[^\w\s-]/g, '').trim();
    
    const downloadName = filename || `${title}.mp4`;

    // Find the requested format
    const requestedFormat = info.formats.find(f => f.itag.toString() === formatId);
    
    if (!requestedFormat) {
      return res.status(404).json({ error: 'Format not found' });
    }

    // If format has audio, stream directly
    if (requestedFormat.hasAudio) {
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Type', 'video/mp4');

      const stream = ytdl(url, { 
        format: requestedFormat,
        agent
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
      const outputPath = path.join(TEMP_FOLDER, `${tempId}_merged.mp4`);

      try {
        // Get best audio format
        const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
        
        if (!audioFormat) {
          return res.status(500).json({ error: 'No audio format available' });
        }

        // Download video and audio
        await Promise.all([
          downloadToFile(url, requestedFormat, videoPath),
          downloadToFile(url, audioFormat, audioPath)
        ]);

        // Merge and stream the result
        await new Promise((resolve, reject) => {
          res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
          res.setHeader('Content-Type', 'video/mp4');

          ffmpeg()
            .input(videoPath)
            .input(audioPath)
            .outputOptions([
              '-c:v copy',
              '-c:a aac',
              '-strict experimental',
              '-movflags frag_keyframe+empty_moov' // Enable streaming
            ])
            .format('mp4')
            .on('end', () => {
              // Clean up temp files
              fs.unlink(videoPath).catch(console.error);
              fs.unlink(audioPath).catch(console.error);
              fs.unlink(outputPath).catch(console.error);
              resolve();
            })
            .on('error', (err) => {
              console.error('FFmpeg error:', err);
              // Clean up temp files
              fs.unlink(videoPath).catch(console.error);
              fs.unlink(audioPath).catch(console.error);
              fs.unlink(outputPath).catch(console.error);
              reject(err);
            })
            .pipe(res);
        });

      } catch (error) {
        // Clean up any temp files
        fs.unlink(videoPath).catch(console.error);
        fs.unlink(audioPath).catch(console.error);
        fs.unlink(outputPath).catch(console.error);
        throw error;
      }
    }

  } catch (error) {
    console.error('Direct download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Helper function to download stream to file
const downloadToFile = (url, format, outputPath) => {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, { format, agent });
    const writeStream = require('fs').createWriteStream(outputPath);

    stream.on('error', reject);
    stream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
};

// Cookie upload endpoint
const upload = multer({ dest: 'temp/' });
app.post('/api/upload-cookie', upload.single('cookie_file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    await fs.copyFile(req.file.path, COOKIE_FILE);
    await fs.unlink(req.file.path); // Clean up temp file
    res.json({ 
      success: true, 
      message: 'Cookie file uploaded successfully' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize directories and start server
const startServer = async () => {
  await createDirectories();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`YouTube Downloader API running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
  });
};

startServer().catch(console.error);
