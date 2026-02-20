const fs = require("fs");
const path = require("path");
const getRecentRecordings = async (time) => {
  const recordingsDir = path.join(__dirname, "recordings", "tapo");

  // Get the files that are 30 seconds ago, our recording filename is in the format of YYYY-MM-DD_HH-MM-SS.mp4, so we can filter by filename to get the recent recordings

  const files = fs.readdirSync(recordingsDir);

  const recordings = files.map((file) => {
    return {
      name: file,
      path: path.join(recordingsDir, file),
    };
  });

  // Only include files that are within the last 2 minutes, and are larger than 0.2 MB (to filter out very small files that are likely not valid recordings)
  const filteredRecordings = recordings.filter((file) => {
    const timestampStr = file.name.split(".")[0]; // Get the part before .mp4
    // Split YYYY-MM-DD_HH-MM-SS into date and time parts, then format correctly
    const [datePart, timePart] = timestampStr.split("_");
    const timestamp = new Date(
      `${datePart} ${timePart.replace(/-/g, ":")}`,
    ).getTime();
    const fileSizeInMB = fs.statSync(file.path).size / (1024 * 1024);

    const isWithinTimeRange = timestamp >= time - 120000 && timestamp <= time;
    const isLargeEnough = fileSizeInMB > 0.1;

    return isWithinTimeRange && isLargeEnough;
  });

  const sortedRecordings = filteredRecordings.sort((a, b) => {
    const sizeA = fs.statSync(a.path).size;
    const sizeB = fs.statSync(b.path).size;
    return sizeB - sizeA;
  });

  return sortedRecordings.slice(0, 5);
};

// Create new folders for each moves recording to alerts_clips, and move the files there, then return the new paths to include in the alert record
const moveRecordingsToAlerts = async (recordings) => {
  const alertsClipsDir = path.join(__dirname, "alerts_clips");
  const dateTimeUniqueId = new Date().toISOString().replace(/[:.]/g, "-"); // Use ISO string with replaced characters for uniqueness
  const alertSpecificDir = path.join(
    alertsClipsDir,
    `anomaly_${dateTimeUniqueId}`,
  );
  if (!fs.existsSync(alertSpecificDir)) {
    fs.mkdirSync(alertSpecificDir, { recursive: true });
  }

  // Instead of really moving the files, we can just copy them to the new location and keep the original recordings for now, to avoid any issues with the recording process. We can implement a cleanup process later to delete old recordings if needed.
  recordings.forEach((recording) => {
    recording.newPath = path.join(alertSpecificDir, recording.name);

    fs.copyFileSync(recording.path, recording.newPath);
  });
  return recordings;
};

const queueUpload = async (file) => {
  const storageRef = admin.storage().bucket().file(file.name);
  await storageRef.save(file.path);
  console.log(`✅ File uploaded: ${file.name}`);
};

const getLinks = async (files) => {
  const links = [];
  for (const file of files) {
    const storageRef = admin.storage().bucket().file(file.name);
    const url = await storageRef.getSignedUrl({
      action: "read",
      expires: "03-01-2500",
    });
    links.push(url[0]);
  }
  return links;
};

const listVideosInDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    console.warn(`⚠️ Directory not found: ${dirPath}`);
    return [];
  }

  const files = fs.readdirSync(dirPath, { withFileTypes: true });
  let videoFiles = [];

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file.name);
    if (file.isDirectory()) {
      videoFiles = videoFiles.concat(listVideosInDir(fullPath));
    } else if (file.name.endsWith(".mp4")) {
      const stats = fs.statSync(fullPath);
      videoFiles.push({
        name: file.name,
        size: (stats.size / (1024 * 1024)).toFixed(2) + " MB",
        date: stats.mtime,
        path: fullPath,
      });
    }
  });

  // Sort by date descending
  return videoFiles.sort((a, b) => b.date - a.date);
};

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

const generateThumbnail = async (videoPath, thumbnailPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        console.error("Error generating thumbnail:", err);
        reject(err);
      })
      .screenshots({
        count: 1,
        folder: path.dirname(thumbnailPath),
        filename: path.basename(thumbnailPath),
        size: "320x?",
      });
  });
};

const listAnomalyFolders = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  const folders = items
    .filter((item) => item.isDirectory() && item.name.startsWith("anomaly_"))
    .map((folder) => {
      const folderPath = path.join(dirPath, folder.name);
      const files = fs.readdirSync(folderPath);
      const videoCount = files.filter((f) => f.endsWith(".mp4")).length;

      // Extract timestamp from folder name: anomaly_2024-02-18T10-30-00-000Z
      // Formatting it to be readable
      const timestampRaw = folder.name
        .replace("anomaly_", "")
        .replace(/-/g, ":")
        .replace("T", " ");

      return {
        name: folder.name,
        path: folderPath,
        videoCount,
        date: fs.statSync(folderPath).birthtime, // Use creation time of folder
      };
    });

  return folders.sort((a, b) => b.date - a.date);
};

const getVideosWithThumbnails = async (dirPath, subDir = "") => {
  const targetDir = subDir ? path.join(dirPath, subDir) : dirPath;
  const videos = listVideosInDir(targetDir);
  const thumbnailsDir = path.join(__dirname, "thumbnails");

  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }

  const processedVideos = await Promise.all(
    videos.map(async (video) => {
      const thumbnailName = `${path.basename(video.name, ".mp4")}.jpg`;
      const thumbnailPath = path.join(thumbnailsDir, thumbnailName);

      if (!fs.existsSync(thumbnailPath)) {
        try {
          await generateThumbnail(video.path, thumbnailPath);
        } catch (e) {
          console.error(`Failed to generate thumbnail for ${video.name}`, e);
          return {
            ...video,
            thumbnailUrl: null,
          };
        }
      }

      return {
        ...video,
        thumbnailUrl: `/thumbnails/${thumbnailName}`,
      };
    }),
  );

  return processedVideos;
};

module.exports = {
  getRecentRecordings,
  moveRecordingsToAlerts,
  queueUpload,
  getLinks,
  listVideosInDir,
  getVideosWithThumbnails,
  listAnomalyFolders,
};
