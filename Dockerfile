FROM gitpod/workspace-full

USER gitpod

# Install FFmpeg
RUN sudo apt-get update && sudo apt-get install -y ffmpeg

# Install Node.js (if not already included)
RUN sudo apt-get install -y nodejs npm
