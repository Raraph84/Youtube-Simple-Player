import child_process from "child_process";
import path from "path";
import fs from "fs";
import express from "express";
import ffmpegStatic from "ffmpeg-static";

const CACHE_SIZE = 10 * 1024 * 1024 * 1024;

fs.chmodSync("yt-dlp_linux", 0o755);
fs.rmSync("downloads", { recursive: true, force: true });
fs.mkdirSync("downloads", { recursive: true });

const videos: {
    [key: string]: {
        size: number;
        audioSource: { state: "pending" | "running" | "done" | "deleted"; locks: number; path: string };
        fragMp4: { state: "pending" | "running" | "done" | "deleted"; locks: number; path: string };
        fullMp4: { state: "pending" | "done"; locks: number; path: string; lastUsed: number };
    };
} = {};

const garbageCollect = async () => {
    for (const video of Object.values(videos)) {
        if (video.audioSource.state === "done" && !video.audioSource.locks) {
            video.audioSource.state = "deleted";
            await fs.promises.unlink(video.audioSource.path);
        }
        if (video.fragMp4.state === "done" && !video.fragMp4.locks) {
            video.fragMp4.state = "deleted";
            await fs.promises.unlink(video.fragMp4.path);
        }
    }

    const deletableVideos = Object.entries(videos)
        .filter(
            ([_, video]) =>
                video.audioSource.state === "deleted" &&
                video.fragMp4.state === "deleted" &&
                video.fullMp4.state === "done" &&
                !video.fragMp4.locks &&
                video.fullMp4.lastUsed + 5 * 60 * 1000 < Date.now()
        )
        .sort(([_a, a], [_b, b]) => a.fullMp4.lastUsed - b.fullMp4.lastUsed);
    for (const [id, video] of deletableVideos) {
        if (Object.values(videos).reduce((acc, v) => acc + v.size, 0) <= CACHE_SIZE) break;
        delete videos[id];
        await fs.promises.unlink(video.fullMp4.path);
    }
};

const download = async (info: any) => {
    if (videos[info.id]) throw new Error("Video is already being downloaded");

    info.formats.reverse();
    const bestAudio = info.formats.find((f: any) => f.vcodec === "none" && f.acodec !== "none");
    const bestVideo = info.formats.find((f: any) => f.vcodec !== "none" && f.acodec === "none");

    videos[info.id] = {
        audioSource: { state: "pending", locks: 1, path: `downloads/${info.id}-audio.${bestAudio.ext}` },
        fragMp4: { state: "pending", locks: 1, path: `downloads/${info.id}-frag.mp4` },
        fullMp4: { state: "pending", locks: 0, path: `downloads/${info.id}.mp4`, lastUsed: Date.now() },
        size: (bestVideo.filesize ?? bestVideo.filesize_approx) + (bestAudio.filesize ?? bestAudio.filesize_approx)
    };
    const video = videos[info.id]!;

    console.log(`Preparing audio for ${info.id}...`);
    let ytdlp = child_process.spawn("./yt-dlp_linux", [
        "--js-runtimes",
        "node",
        "-f",
        bestAudio.format_id,
        "-o",
        video.audioSource.path,
        "--",
        info.id
    ]);
    ytdlp.stderr.resume();

    while (!fs.existsSync(video.audioSource.path) && ytdlp.exitCode === null)
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (ytdlp.exitCode !== null && ytdlp.exitCode !== 0) throw new Error(`yt-dlp exited with code ${ytdlp.exitCode}`);
    video.audioSource.state = "running";
    await new Promise<void>((resolve) => ytdlp.on("close", resolve));
    video.audioSource.state = "done";

    console.log(`Preparing frag for ${info.id}...`);
    ytdlp = child_process.spawn("./yt-dlp_linux", [
        "--js-runtimes",
        "node",
        "-f",
        bestVideo.format_id,
        "-o",
        "-",
        "--",
        info.id
    ]);
    ytdlp.stderr.resume();
    let ffmpeg = child_process.spawn(ffmpegStatic as unknown as string, [
        "-i",
        video.audioSource.path,
        "-i",
        "-",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov",
        video.fragMp4.path
    ]);
    ffmpeg.stderr.resume();

    ytdlp.stdout.pipe(ffmpeg.stdin);

    while (!fs.existsSync(video.fragMp4.path) && ytdlp.exitCode === null)
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (ytdlp.exitCode !== null && ytdlp.exitCode !== 0) throw new Error(`yt-dlp exited with code ${ytdlp.exitCode}`);
    video.fragMp4.state = "running";
    await new Promise<void>((resolve) => ffmpeg.on("close", resolve));
    video.fragMp4.state = "done";
    video.audioSource.locks--;
    garbageCollect();

    console.log(`Preparing full for ${info.id}...`);
    ffmpeg = child_process.spawn(ffmpegStatic as unknown as string, [
        "-i",
        video.fragMp4.path,
        "-c",
        "copy",
        video.fullMp4.path
    ]);
    ffmpeg.stderr.resume();

    await new Promise<void>((resolve) => ffmpeg.on("close", resolve));
    video.fullMp4.state = "done";
    video.fragMp4.locks--;

    const stat = await fs.promises.stat(video.fullMp4.path);
    video.size = stat.size;

    garbageCollect();

    console.log(`Done ${info.id}!`);
};

const app = express();

app.get("/:id", async (req, res) => {
    const id = req.params.id;
    const full = "full" in req.query;

    if (!videos[id]) {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            res.status(400).json({ error: "Invalid video" });
            return;
        }

        if (Object.values(videos).reduce((acc, v) => acc + v.size, 0) > CACHE_SIZE) await garbageCollect();
        if (Object.values(videos).reduce((acc, v) => acc + v.size, 0) > CACHE_SIZE) {
            res.status(400).json({ error: "Cache is full" });
            return;
        }

        let info;
        try {
            info = await new Promise<any>((resolve, reject) =>
                child_process.exec(
                    `./yt-dlp_linux --js-runtimes node -j -- ${id}`,
                    { maxBuffer: 128 * 1024 * 1024 },
                    (error, stdout, stderr) => (error ? reject(error) : resolve(JSON.parse(stdout)))
                )
            );
        } catch (error) {
            if (
                error instanceof Error &&
                (error.message.includes("is not a valid URL") || error.message.includes("Video unavailable"))
            ) {
                res.status(400).json({ error: "Invalid video" });
                return;
            }
            console.log(`Error fetching info for ${id}:`, error);
            res.status(500).json({ error: "Internal server error" });
            return;
        }

        if (!videos[info.id]) download(info);
    }

    const video = videos[id]!;
    if (full || video.fullMp4.state === "done") {
        video.fullMp4.locks++;
        while (video.fullMp4.state === "pending") await new Promise<void>((resolve) => setTimeout(resolve, 50));
        video.fullMp4.lastUsed = Date.now();
        res.on("close", () => video.fullMp4.locks--);
        res.sendFile(path.resolve(video.fullMp4.path));
    } else {
        video.fragMp4.locks++;
        while (video.fragMp4.state === "pending") await new Promise<void>((resolve) => setTimeout(resolve, 50));

        console.log(`Serving frag ${id}`);
        req.on("close", () => {
            console.log(`Ended serving frag ${id}`);
            video.fragMp4.locks--;
            garbageCollect();
        });

        const CHUNK_SIZE = 8 * 1024 * 1024;
        const fd = await fs.promises.open(video.fragMp4.path, "r");
        let position = 0;
        while (!req.destroyed) {
            const buffer = Buffer.alloc(CHUNK_SIZE);
            const { bytesRead } = await fd.read(buffer, 0, CHUNK_SIZE, position);
            if (bytesRead > 0) {
                position += bytesRead;
                const wait = res.write(buffer.subarray(0, bytesRead));
                if (!wait) {
                    await new Promise<void>((resolve) => {
                        const cleanup = () => {
                            res.off("drain", cleanup);
                            req.off("close", cleanup);
                            resolve();
                        };
                        res.once("drain", cleanup);
                        req.once("close", cleanup);
                    });
                }
            } else {
                if (video.fragMp4.state === "done") break;
                await new Promise<void>((resolve) => setTimeout(resolve, 50));
            }
        }
        await fd.close();
        res.end();
    }
});

app.listen(3000, () => {
    console.log("Server is running on http://localhost:3000");
});
