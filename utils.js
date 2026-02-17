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
            `${datePart} ${timePart.replace(/-/g, ":")}`
        ).getTime();
        const fileSizeInMB = fs.statSync(file.path).size / (1024 * 1024);

        const isWithinTimeRange = timestamp >= time - 120000 && timestamp <= time;
        const isLargeEnough = fileSizeInMB > 0.1;

        console.log(`📹 File: ${file.name}, Size: ${fileSizeInMB.toFixed(2)}MB, Age: ${((time - timestamp) / 1000).toFixed(1)}s, Valid: ${isWithinTimeRange && isLargeEnough}`);

        return isWithinTimeRange && isLargeEnough;
    });

    const sortedRecordings = filteredRecordings.sort((a, b) => {
        const sizeA = fs.statSync(a.path).size;
        const sizeB = fs.statSync(b.path).size;
        return sizeB - sizeA;
    });

    console.log("🎬 Recent valid recordings found:", sortedRecordings);

    return sortedRecordings.slice(0, 5);
}

// Create new folders for each moves recording to alerts_clips, and move the files there, then return the new paths to include in the alert record
const moveRecordingsToAlerts = async (recordings) => {
    const alertsClipsDir = path.join(__dirname, "alerts_clips");
    const dateTimeUniqueId = new Date().toISOString().replace(/[:.]/g, "-"); // Use ISO string with replaced characters for uniqueness
    const alertSpecificDir = path.join(alertsClipsDir, `anomaly_${dateTimeUniqueId}`);
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


module.exports = {
    getRecentRecordings,
    moveRecordingsToAlerts,
}