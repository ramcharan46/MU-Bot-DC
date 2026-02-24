const { DisTubeError, PlayableExtractorPlugin, Playlist, Song } = require("distube");
const { download: downloadYtDlp, json: ytDlpJson } = require("@distube/yt-dlp");

const YT_DLP_BASE_FLAGS = {
  dumpSingleJson: true,
  noWarnings: true,
  quiet: true,
  preferFreeFormats: true,
  skipDownload: true,
  simulate: true,
};

function isYtDlpPlaylist(info) {
  return Array.isArray(info?.entries);
}

function normalizePlayableInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z]+search\d*:/i.test(raw)) return raw;
  return `ytsearch1:${raw}`;
}

function stringifyYtDlpError(error) {
  if (!error) return "Unknown yt-dlp error";
  if (typeof error === "string") return error;
  if (typeof error.stderr === "string" && error.stderr.trim()) return error.stderr.trim();
  if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
  return String(error);
}

class YtDlpCompatSong extends Song {
  constructor(plugin, info, options = {}) {
    super(
      {
        plugin,
        source: info?.extractor || "yt-dlp",
        playFromSource: true,
        id: String(info?.id || ""),
        name: info?.title || info?.fulltitle || "Unknown track",
        url: info?.webpage_url || info?.original_url || info?.url || "",
        isLive: Boolean(info?.is_live),
        thumbnail: info?.thumbnail || info?.thumbnails?.[0]?.url || null,
        duration: info?.is_live ? 0 : Number(info?.duration || 0),
        uploader: {
          name: info?.uploader || "Unknown",
          url: info?.uploader_url || null,
        },
        views: Number(info?.view_count || 0),
        likes: Number(info?.like_count || 0),
        dislikes: Number(info?.dislike_count || 0),
        reposts: Number(info?.repost_count || 0),
        ageRestricted: Boolean(info?.age_limit) && Number(info.age_limit) >= 18,
      },
      options,
    );
  }
}

class YtDlpCompatPlugin extends PlayableExtractorPlugin {
  constructor({ update } = {}) {
    super();
    if (update ?? true) downloadYtDlp().catch(() => null);
  }

  init(distube) {
    super.init(distube);
    if (this.distube.plugins[this.distube.plugins.length - 1] !== this) {
      console.warn(`[${this.constructor.name}] This plugin is not the last plugin in distube. This is not recommended.`);
    }
  }

  validate() {
    return true;
  }

  async resolve(query, options) {
    const input = normalizePlayableInput(query);
    if (!input) throw new DisTubeError("NO_RESULT", "Empty query.");

    const info = await ytDlpJson(input, YT_DLP_BASE_FLAGS).catch((error) => {
      throw new DisTubeError("YTDLP_ERROR", stringifyYtDlpError(error));
    });

    if (isYtDlpPlaylist(info)) {
      const songs = info.entries.filter(Boolean).map((entry) => new YtDlpCompatSong(this, entry, options));
      if (!songs.length) throw new DisTubeError("NO_RESULT", "The playlist is empty.");

      return new Playlist(
        {
          source: info?.extractor || "yt-dlp",
          songs,
          id: String(info?.id || ""),
          name: info?.title || "Playlist",
          url: info?.webpage_url || input,
          thumbnail: info?.thumbnail || info?.thumbnails?.[0]?.url || null,
        },
        options,
      );
    }

    return new YtDlpCompatSong(this, info, options);
  }

  async getStreamURL(song) {
    const source = String(song?.url || "").trim();
    if (!source) {
      throw new DisTubeError("YTDLP_PLUGIN_INVALID_SONG", "Cannot get stream URL from an invalid song.");
    }

    const info = await ytDlpJson(source, {
      ...YT_DLP_BASE_FLAGS,
      format: "ba/ba*",
    }).catch((error) => {
      throw new DisTubeError("YTDLP_ERROR", stringifyYtDlpError(error));
    });

    if (isYtDlpPlaylist(info)) {
      throw new DisTubeError("YTDLP_ERROR", "Cannot get stream URL for a playlist.");
    }

    const streamUrl = String(info?.url || "").trim();
    if (!/^https?:\/\//i.test(streamUrl)) {
      throw new DisTubeError("YTDLP_ERROR", "No playable stream URL was returned.");
    }
    return streamUrl;
  }

  getRelatedSongs() {
    return [];
  }
}

module.exports = {
  YT_DLP_BASE_FLAGS,
  YtDlpCompatPlugin,
  normalizePlayableInput,
  ytDlpJson,
};

