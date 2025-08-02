const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');

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

// Create agent with better headers to avoid detection
const agent = ytdl.createAgent([], {
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

    // Filter and map audio formats (MP4 only)
    const audioFormats = formats
      .filter(format => 
        format.hasAudio && 
        !format.hasVideo && 
        format.audioBitrate &&
        (format.container === 'mp4' || format.mimeType?.includes('mp4'))
      )
      .reduce((unique, format) => {
        // Remove duplicates by format_id
        const exists = unique.find(f => f.format_id === format.itag.toString());
        if (!exists) {
          unique.push({
            format_id: format.itag.toString(),
            ext: 'mp4',
            format_note: `${format.audioBitrate}kbps`,
            abr: format.audioBitrate,
            filesize: format.contentLength ? parseInt(format.contentLength) : null,
            direct_url: format.url
          });
        }
        return unique;
      }, [])
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    // Filter and map video formats (MP4 only)
    const videoFormats = formats
      .filter(format => 
        format.hasVideo && 
        format.height &&
        (format.container === 'mp4' || format.mimeType?.includes('mp4'))
      )
      .reduce((unique, format) => {
        // Remove duplicates by format_id
        const exists = unique.find(f => f.format_id === format.itag.toString());
        if (!exists) {
          unique.push({
            format_id: format.itag.toString(),
            ext: 'mp4',
            format_note: format.qualityLabel || `${format.height}p`,
            width: format.width,
            height: format.height,
            fps: format.fps,
            vcodec: format.videoCodec,
            acodec: format.hasAudio ? format.audioCodec : 'none',
            filesize: format.contentLength ? parseInt(format.contentLength) : null,
            direct_url: format.url,
            resolution: `${format.width}x${format.height}`
          });
        }
        return unique;
      }, [])
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
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0.0',
    platform: 'nodejs',
    features: 'direct_streaming_only'
  });
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
    console.error('Get video info error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Direct stream endpoint
app.get('/api/stream/:videoId/:formatId', async (req, res) => {
  const { videoId, formatId } = req.params;
  const { filename } = req.query;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const info = await ytdl.getInfo(url, { agent });
    const videoDetails = info.videoDetails;
    const title = videoDetails.title.replace(/[^\w\s\-\.]/g, '').trim();

    // Find the requested format
    const requestedFormat = info.formats.find(f => f.itag.toString() === formatId);

    if (!requestedFormat) {
      return res.status(404).json({ error: 'Format not found' });
    }

    // Determine file extension and content type
    const fileExtension = requestedFormat.container || 'mp4';
    const downloadName = filename || `${title}.${fileExtension}`;

    let contentType = 'video/mp4';
    if (requestedFormat.hasAudio && !requestedFormat.hasVideo) {
      contentType = fileExtension === 'webm' ? 'audio/webm' : 'audio/mp4';
    }

    // Set response headers
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Type', contentType);

    if (requestedFormat.contentLength) {
      res.setHeader('Content-Length', requestedFormat.contentLength);
    }

    // Create and pipe the stream
    const stream = ytdl(url, { 
      format: requestedFormat,
      agent
    });

    stream.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed' });
      }
    });

    stream.on('end', () => {
      console.log(`Stream completed for: ${title}`);
    });

    stream.pipe(res);

  } catch (error) {
    console.error('Direct stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get direct download URLs (without streaming through server)
app.get('/api/get-urls/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const info = await ytdl.getInfo(url, { agent });
    const formats = info.formats;

    // Get direct URLs for MP4 audio formats only
    const audioUrls = formats
      .filter(format => 
        format.hasAudio && 
        !format.hasVideo && 
        format.audioBitrate &&
        (format.container === 'mp4' || format.mimeType?.includes('mp4'))
      )
      .reduce((unique, format) => {
        const exists = unique.find(f => f.format_id === format.itag.toString());
        if (!exists) {
          unique.push({
            format_id: format.itag.toString(),
            ext: 'mp4',
            format_note: `${format.audioBitrate}kbps`,
            abr: format.audioBitrate,
            filesize: format.contentLength ? parseInt(format.contentLength) : null,
            direct_url: format.url
          });
        }
        return unique;
      }, [])
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    // Get direct URLs for MP4 video formats only
    const videoUrls = formats
      .filter(format => 
        format.hasVideo && 
        format.height &&
        (format.container === 'mp4' || format.mimeType?.includes('mp4'))
      )
      .reduce((unique, format) => {
        const exists = unique.find(f => f.format_id === format.itag.toString());
        if (!exists) {
          unique.push({
            format_id: format.itag.toString(),
            ext: 'mp4',
            format_note: format.qualityLabel || `${format.height}p`,
            width: format.width,
            height: format.height,
            fps: format.fps,
            vcodec: format.videoCodec,
            acodec: format.hasAudio ? format.audioCodec : 'none',
            filesize: format.contentLength ? parseInt(format.contentLength) : null,
            direct_url: format.url,
            resolution: `${format.width}x${format.height}`
          });
        }
        return unique;
      }, [])
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    res.json({
      video_id: videoId,
      title: info.videoDetails.title,
      audio_urls: audioUrls,
      video_urls: videoUrls,
      expires_in: '6 hours',
      note: 'Direct YouTube URLs expire after some time. Use immediately or refresh to get new URLs.'
    });

  } catch (error) {
    console.error('Get URLs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Simplified YouTube API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Features: Direct streaming only, no file storage`);
});
