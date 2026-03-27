// ==========================================================================
// Constants
// ==========================================================================

const PLATFORM = "NASA+";
const BASE_URL = "https://plus.nasa.gov";
const API_BASE_URL = "https://plus.nasa.gov/wp-json/wp/v2";
const CUSTOM_API_BASE_URL = "https://plus.nasa.gov/wp-json/nasaplus/v1";
const CHANNEL_THUMBNAIL_URL = "https://www.nasa.gov/wp-content/themes/nasa/assets/images/nasa-logo@2x.png";
const CHANNEL_DESCRIPTION = "NASA+ is NASA's on-demand streaming service. Watch original series, live coverage, and explore NASA's missions across air and space.";
const PLUGIN_ICON_URL = "https://plugins.grayjay.app/NASA-Plus/NASA-PlusIcon.png";

const REQUEST_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36"
};

const ITEMS_PER_PAGE = 20;
const PREVIEW_RUNTIME_THRESHOLD = 120;

Type.Feed.Playlists = "Playlists";

// ==========================================================================
// Regex Patterns
// ==========================================================================

/**
 * Matches NASA+ video page URLs.
 * @example https://plus.nasa.gov/video/moonbound-for-all-humanity/
 */
const VIDEO_URL_REGEX = /plus\.nasa\.gov\/video\/([^\/\?#]+)/;

/**
 * Matches NASA+ series page URLs.
 * @example https://plus.nasa.gov/series/moonbound/
 */
const SERIES_URL_REGEX = /plus\.nasa\.gov\/series\/([^\/\?#]+)/;

/**
 * Matches NASA+ topic page URLs.
 * @example https://plus.nasa.gov/topics/earth/
 */
const TOPIC_URL_REGEX = /plus\.nasa\.gov\/topics\/([^\/\?#]+)/;

/**
 * Matches NASA+ scheduled video/event page URLs.
 * @example https://plus.nasa.gov/scheduled-video/nasas-spacex-crew-12-launch/
 */
const SCHEDULED_VIDEO_URL_REGEX = /plus\.nasa\.gov\/scheduled-video\/([^\/\?#]+)/;

/**
 * Matches the NASA+ main channel URL.
 * @example https://plus.nasa.gov or https://plus.nasa.gov/
 */
const CHANNEL_URL_REGEX = /^https?:\/\/plus\.nasa\.gov\/?$/;

// ==========================================================================
// State
// ==========================================================================

let config = {};
let settings = {};
let state = {
    topics: [],
    series: [],
    topicsFetchedAt: 0,
    seriesFetchedAt: 0
};

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// ==========================================================================
// Source Functions
// ==========================================================================

/**
 * Initializes the plugin with config, settings, and restored state.
 * @param {SourceConfig} conf - Plugin configuration
 * @param {Object} sett - Plugin settings
 * @param {string} savedStateStr - Previously saved state as JSON string
 */
source.enable = function (conf, sett, savedStateStr) {
    config = conf ?? {};
    settings = sett ?? {};

    if (savedStateStr) {
        try {
            const parsed = JSON.parse(savedStateStr);
            if (parsed.topics) state.topics = parsed.topics;
            if (parsed.series) state.series = parsed.series;
            if (parsed.topicsFetchedAt) state.topicsFetchedAt = parsed.topicsFetchedAt;
            if (parsed.seriesFetchedAt) state.seriesFetchedAt = parsed.seriesFetchedAt;
        } catch (e) {
            log("Failed to parse saved state: " + e.message);
        }
    }
};

/**
 * Serializes plugin state for persistence across sessions.
 * @returns {string} JSON string of the current state
 */
source.saveState = function () {
    if (IS_TESTING) return "";
    return JSON.stringify(state);
};

/**
 * Returns the home feed with the most recent NASA+ videos.
 * @returns {NASAVideoPager}
 */
source.getHome = function () {
    const scheduledUrl = API_BASE_URL + "/scheduled_video?per_page=20&orderby=date&order=desc&_embed=wp:featuredmedia";
    const videosUrl = API_BASE_URL + "/video?per_page=" + ITEMS_PER_PAGE + "&page=1&orderby=date&order=desc";

    const batchResults = http.batch()
        .GET(scheduledUrl, REQUEST_HEADERS, false)
        .GET(videosUrl, REQUEST_HEADERS, false)
        .execute();

    const liveVideos = parseScheduledResponse(batchResults[0]);
    const regularPage = parseVideosResponse(batchResults[1], 1, {});

    if (liveVideos.length > 0) {
        const combined = liveVideos.concat(regularPage.results);
        return new NASAVideoPager(combined, regularPage.hasMore, 1, {});
    }

    return regularPage;
};

/**
 * Checks if the given URL is a NASA+ channel URL (series or topic page).
 * @param {string} url
 * @returns {boolean}
 */
source.isChannelUrl = function (url) {
    return CHANNEL_URL_REGEX.test(url) || SERIES_URL_REGEX.test(url) || TOPIC_URL_REGEX.test(url);
};

/**
 * Returns channel information for a NASA+ series or topic.
 * @param {string} url - Channel URL
 * @returns {PlatformChannel}
 */
source.getChannel = function (url) {
    if (CHANNEL_URL_REGEX.test(url)) {
        return getNASAChannel();
    }

    const seriesMatch = url.match(SERIES_URL_REGEX);
    if (seriesMatch) {
        return getSeriesChannel(seriesMatch[1]);
    }

    const topicMatch = url.match(TOPIC_URL_REGEX);
    if (topicMatch) {
        return getTopicChannel(topicMatch[1]);
    }

    return getNASAChannel();
};

/**
 * Returns the capabilities of a NASA+ channel.
 * @returns {Object}
 */
source.getChannelCapabilities = function () {
    return {
        types: [Type.Feed.Videos, Type.Feed.Playlists],
        sorts: [Type.Order.Chronological]
    };
};

/**
 * Returns channel contents (videos or playlists) for a series or topic.
 * @param {string} url - Channel URL
 * @param {string} type - Content type (Videos or Playlists)
 * @param {string} order - Sort order
 * @param {Object} filters - Content filters
 * @returns {NASAVideoPager|NASAPlaylistPager}
 */
source.getChannelContents = function (url, type, order, filters) {
    if (CHANNEL_URL_REGEX.test(url)) {
        if (type === Type.Feed.Playlists) {
            return getSeriesPlaylists();
        }

        const scheduledUrl = API_BASE_URL + "/scheduled_video?per_page=20&orderby=date&order=desc&_embed=wp:featuredmedia";
        const videosUrl = API_BASE_URL + "/video?per_page=" + ITEMS_PER_PAGE + "&page=1&orderby=date&order=desc";

        const batchResults = http.batch()
            .GET(scheduledUrl, REQUEST_HEADERS, false)
            .GET(videosUrl, REQUEST_HEADERS, false)
            .execute();

        const liveVideos = parseScheduledResponse(batchResults[0]);
        const regularPage = parseVideosResponse(batchResults[1], 1, {});

        if (liveVideos.length > 0) {
            const combined = liveVideos.concat(regularPage.results);
            return new NASAVideoPager(combined, regularPage.hasMore, 1, {});
        }

        return regularPage;
    }

    const seriesMatch = url.match(SERIES_URL_REGEX);
    if (seriesMatch) {
        if (type === Type.Feed.Playlists) {
            return getSeriesAsPlaylist(seriesMatch[1]);
        }
        const seriesId = findSeriesIdBySlug(seriesMatch[1]);
        if (seriesId) {
            return fetchVideosPage(1, { series: seriesId });
        }
    }

    const topicMatch = url.match(TOPIC_URL_REGEX);
    if (topicMatch) {
        if (type === Type.Feed.Playlists) {
            return getTopicSeriesPlaylists(topicMatch[1]);
        }
        const topicId = findTopicIdBySlug(topicMatch[1]);
        if (topicId) {
            return fetchVideosPage(1, { topic: topicId });
        }
    }

    return fetchVideosPage(1, {});
};

/**
 * Returns playlists for the NASA+ channel (all series).
 * @param {string} url - Channel URL
 * @returns {NASAPlaylistPager}
 */
source.getChannelPlaylists = function (url) {
    const seriesMatch = url.match(SERIES_URL_REGEX);
    if (seriesMatch) {
        return getSeriesAsPlaylist(seriesMatch[1]);
    }

    const topicMatch = url.match(TOPIC_URL_REGEX);
    if (topicMatch) {
        return getTopicSeriesPlaylists(topicMatch[1]);
    }

    return getSeriesPlaylists();
};

/**
 * Checks if the given URL is a NASA+ playlist (series) URL.
 * @param {string} url
 * @returns {boolean}
 */
source.isPlaylistUrl = function (url) {
    return SERIES_URL_REGEX.test(url);
};

/**
 * Returns playlist details for a NASA+ series.
 * @param {string} url - Series URL
 * @returns {PlatformPlaylistDetails}
 */
source.getPlaylist = function (url) {
    const match = url.match(SERIES_URL_REGEX);
    if (!match) {
        throw new ScriptException("Invalid playlist URL: " + url);
    }

    const slug = match[1];
    const seriesObj = findSeriesBySlug(slug);

    if (!seriesObj) {
        throw new ScriptException("Series not found: " + slug);
    }

    const contentsPager = fetchVideosPage(1, { series: seriesObj.id, order: "asc" });

    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, "series-" + slug, config.id),
        name: seriesObj.name,
        author: nasaAuthor(),
        url: BASE_URL + "/series/" + slug + "/",
        thumbnail: "",
        videoCount: seriesObj.count || -1,
        contents: contentsPager
    });
};

/**
 * Checks if the given URL points to a NASA+ video.
 * @param {string} url
 * @returns {boolean}
 */
source.isContentDetailsUrl = function (url) {
    return VIDEO_URL_REGEX.test(url) || SCHEDULED_VIDEO_URL_REGEX.test(url);
};

/**
 * Returns detailed content information for a specific NASA+ video.
 * @param {string} url - Video page URL
 * @returns {PlatformVideoDetails}
 */
source.getContentDetails = function (url) {
    const scheduledMatch = url.match(SCHEDULED_VIDEO_URL_REGEX);
    if (scheduledMatch) {
        const slug = scheduledMatch[1];
        const resp = httpGET({ url: API_BASE_URL + "/scheduled_video?slug=" + encodeURIComponent(slug) + "&_embed=wp:featuredmedia", parseResponse: true });
        if (!resp.isOk || !resp.body || resp.body.length === 0) {
            throw new ScriptException("Scheduled event not found: " + slug);
        }
        return buildScheduledVideoDetails(resp.body[0]);
    }

    const match = url.match(VIDEO_URL_REGEX);
    if (!match) {
        throw new ScriptException("Invalid video URL: " + url);
    }

    const slug = match[1];
    const resp = httpGET({ url: API_BASE_URL + "/video?slug=" + encodeURIComponent(slug), parseResponse: true });
    if (!resp.isOk || !resp.body || resp.body.length === 0) {
        throw new ScriptException("Video not found: " + slug);
    }

    const video = resp.body[0];
    return buildVideoDetails(video);
};

/**
 * Returns content recommendations for a NASA+ video.
 * Shows other videos from the same series, or latest videos if no series.
 * @param {string} url - Content URL
 * @returns {NASAVideoPager}
 */
source.getContentRecommendations = function (url) {
    const match = url.match(VIDEO_URL_REGEX);
    if (!match) {
        return new NASAVideoPager([], false, 1, {});
    }

    const slug = match[1];
    const resp = httpGET({ url: API_BASE_URL + "/video?slug=" + encodeURIComponent(slug), parseResponse: true });
    if (!resp.isOk || !resp.body || resp.body.length === 0) {
        return new NASAVideoPager([], false, 1, {});
    }

    const video = resp.body[0];
    const relatedVideos = buildRelatedVideos(video);

    const seriesIds = video.series;
    if (seriesIds && seriesIds.length > 0) {
        const seriesPage = fetchVideosPage(1, { series: seriesIds[0], exclude: video.id });
        const seriesIds2 = new Set(relatedVideos.map(function (v) { return v.id.value; }));
        const deduped = seriesPage.results.filter(function (v) { return !seriesIds2.has(v.id.value); });
        const combined = relatedVideos.concat(deduped);
        return new NASAVideoPager(combined, seriesPage.hasMore, 1, { series: seriesIds[0], exclude: video.id });
    }

    if (relatedVideos.length > 0) {
        const latestPage = fetchVideosPage(1, { exclude: video.id });
        const relatedIds = new Set(relatedVideos.map(function (v) { return v.id.value; }));
        const deduped = latestPage.results.filter(function (v) { return !relatedIds.has(v.id.value); });
        const combined = relatedVideos.concat(deduped);
        return new NASAVideoPager(combined, latestPage.hasMore, 1, { exclude: video.id });
    }

    return fetchVideosPage(1, { exclude: video.id });
};

// ==========================================================================
// Search
// ==========================================================================

/**
 * Returns search capabilities.
 * @returns {ResultCapabilities}
 */
source.getSearchCapabilities = function () {
    return new ResultCapabilities(
        [Type.Feed.Videos],
        [Type.Order.Chronological],
        []
    );
};

/**
 * Searches for NASA+ videos.
 * @param {string} query - Search query
 * @param {string} type - Content type
 * @param {string} order - Sort order
 * @param {Object} filters - Search filters
 * @returns {NASASearchPager}
 */
source.search = function (query, type, order, filters) {
    return searchVideos(query, 1);
};

/**
 * Returns search channel contents capabilities.
 * @returns {ResultCapabilities}
 */
source.getSearchChannelContentsCapabilities = function () {
    return new ResultCapabilities(
        [Type.Feed.Videos],
        [Type.Order.Chronological],
        []
    );
};

/**
 * Searches for videos within a channel.
 * @param {string} channelUrl - Channel URL
 * @param {string} query - Search query
 * @param {string} type - Content type
 * @param {string} order - Sort order
 * @param {Object} filters - Search filters
 * @returns {NASASearchPager}
 */
source.searchChannelContents = function (channelUrl, query, type, order, filters) {
    if (!query || query.trim().length === 0) {
        return new NASASearchPager([], false, query, 1);
    }

    const seriesMatch = channelUrl.match(SERIES_URL_REGEX);
    if (seriesMatch) {
        const seriesId = findSeriesIdBySlug(seriesMatch[1]);
        if (seriesId) {
            return searchVideos(query, 1, { series: seriesId });
        }
    }

    const topicMatch = channelUrl.match(TOPIC_URL_REGEX);
    if (topicMatch) {
        const topicId = findTopicIdBySlug(topicMatch[1]);
        if (topicId) {
            return searchVideos(query, 1, { topic: topicId });
        }
    }

    return searchVideos(query, 1);
};

/**
 * Returns search suggestions from the NASA+ API.
 * @param {string} query - Search query
 * @returns {string[]}
 */
source.searchSuggestions = function (query) {
    if (!query || query.trim().length === 0) return [];

    const resp = httpGET({
        url: CUSTOM_API_BASE_URL + "/searchSuggestions/" + encodeURIComponent(query),
        parseResponse: true
    });

    if (!resp.isOk || !resp.body || !Array.isArray(resp.body)) return [];

    return resp.body.map(function (item) { return item.name; });
};

/**
 * Searches for playlists (series) matching the query.
 * @param {string} query - Search query
 * @returns {NASAPlaylistPager}
 */
source.searchPlaylists = function (query) {
    if (!query || query.trim().length === 0) {
        return new NASAPlaylistPager([], false, []);
    }

    const allSeries = fetchAllSeries();
    const lowerQuery = query.toLowerCase();
    const playlists = allSeries
        .filter(function (s) {
            return s.count > 0 && (
                s.name.toLowerCase().indexOf(lowerQuery) !== -1 ||
                (s.description && s.description.toLowerCase().indexOf(lowerQuery) !== -1)
            );
        })
        .sort(function (a, b) { return (b.count || 0) - (a.count || 0); })
        .map(function (s) { return buildSeriesPlaylist(s); });

    return new NASAPlaylistPager(playlists, false, []);
};

/**
 * Searches for channels (series) matching the query.
 * @param {string} query - Search query
 * @returns {NASASeriesSearchPager}
 */
source.searchChannels = function (query) {
    if (!query || query.trim().length === 0) {
        return new NASASeriesSearchPager([], false);
    }

    const allSeries = fetchAllSeries();
    const lowerQuery = query.toLowerCase();
    const matches = allSeries.filter(function (s) {
        return s.name.toLowerCase().indexOf(lowerQuery) !== -1 ||
            (s.description && s.description.toLowerCase().indexOf(lowerQuery) !== -1);
    });

    const channels = matches.map(function (s) { return buildSeriesChannelFromTaxonomy(s); });
    return new NASASeriesSearchPager(channels, false);
};

// ==========================================================================
// Pager Classes
// ==========================================================================

/**
 * Pager for NASA+ video listings with server-side pagination.
 * @extends VideoPager
 */
class NASAVideoPager extends VideoPager {
    /**
     * @param {PlatformVideo[]} results - Current page of video results
     * @param {boolean} hasMore - Whether more pages are available
     * @param {number} page - Current page number (1-based)
     * @param {Object} params - Query parameters for fetching next pages
     */
    constructor(results, hasMore, page, params) {
        super(results, hasMore);
        this.page = page;
        this.params = params;
    }

    nextPage() {
        return fetchVideosPage(this.page + 1, this.params);
    }
}

/**
 * Pager for NASA+ search results with server-side pagination.
 * @extends VideoPager
 */
class NASASearchPager extends VideoPager {
    /**
     * @param {PlatformVideo[]} results - Current page of search results
     * @param {boolean} hasMore - Whether more pages are available
     * @param {string} query - The search query
     * @param {number} page - Current page number (1-based)
     * @param {Object} [params] - Filter parameters (series, topic)
     */
    constructor(results, hasMore, query, page, params) {
        super(results, hasMore);
        this.query = query;
        this.page = page;
        this.params = params;
    }

    nextPage() {
        return searchVideos(this.query, this.page + 1, this.params);
    }
}

/**
 * Pager for series search results (non-paginated).
 * @extends ChannelPager
 */
class NASASeriesSearchPager extends ChannelPager {
    constructor(results, hasMore) {
        super(results, hasMore);
    }

    nextPage() {
        return new NASASeriesSearchPager([], false);
    }
}

/**
 * Pager for series playlists with client-side pagination.
 * @extends PlaylistPager
 */
class NASAPlaylistPager extends PlaylistPager {
    /**
     * @param {PlatformPlaylist[]} results - Current page of playlist results
     * @param {boolean} hasMore - Whether more pages are available
     * @param {PlatformPlaylist[]} pendingItems - Pre-built playlists not yet returned
     */
    constructor(results, hasMore, pendingItems) {
        super(results, hasMore);
        this.pendingItems = pendingItems;
    }

    nextPage() {
        const page = this.pendingItems.slice(0, ITEMS_PER_PAGE);
        const remaining = this.pendingItems.slice(ITEMS_PER_PAGE);
        return new NASAPlaylistPager(page, remaining.length > 0, remaining);
    }
}

// ==========================================================================
// Helper Functions
// ==========================================================================

/**
 * Performs an HTTP GET request with default headers and error handling.
 * @param {Object} options - Request options
 * @param {string} options.url - The URL to fetch
 * @param {boolean} [options.parseResponse=false] - If true, parse response body as JSON
 * @param {Object} [options.headers=null] - Custom headers (overrides defaults)
 * @returns {Object} Response object with isOk, code, body, and headers
 */
function httpGET(options) {
    const {
        url,
        parseResponse = false,
        headers = null
    } = options;

    const localHeaders = headers ?? REQUEST_HEADERS;

    try {
        const response = http.GET(url, localHeaders, false);

        if (!response.isOk) {
            log("HTTP request failed: " + url + " (code: " + response.code + ")");
            return response;
        }

        if (parseResponse) {
            try {
                const parsed = JSON.parse(response.body);
                return {
                    code: response.code,
                    isOk: true,
                    body: parsed
                };
            } catch (e) {
                log("Failed to parse JSON from: " + url + " - " + e.message);
                return { isOk: false, code: response.code, body: null };
            }
        }

        return response;
    } catch (e) {
        log("HTTP request error: " + url + " - " + e.message);
        return { isOk: false, code: 0, body: "", headers: {} };
    }
}

/**
 * Fetches a page of videos from the WordPress REST API.
 * @param {number} page - Page number (1-based)
 * @param {Object} params - Query parameters (series, topic, exclude)
 * @returns {NASAVideoPager}
 */
function fetchVideosPage(page, params) {
    const sortOrder = params.order || "desc";
    let url = API_BASE_URL + "/video?per_page=" + ITEMS_PER_PAGE
        + "&page=" + page + "&orderby=date&order=" + sortOrder;

    if (params.series) url += "&series=" + params.series;
    if (params.topic) url += "&topic=" + params.topic;
    if (params.exclude) url += "&exclude[]=" + params.exclude;

    const resp = http.GET(url, REQUEST_HEADERS, false);
    return parseVideosResponse(resp, page, params);
}

/**
 * Parses a raw HTTP response into a NASAVideoPager.
 * @param {Object} resp - Raw HTTP response
 * @param {number} page - Current page number
 * @param {Object} params - Query parameters for pagination
 * @returns {NASAVideoPager}
 */
function parseVideosResponse(resp, page, params) {
    if (!resp.isOk) {
        log("HTTP request failed (videos): code " + resp.code);
        return new NASAVideoPager([], false, page, params);
    }

    try {
        const items = JSON.parse(resp.body);
        if (!Array.isArray(items)) {
            return new NASAVideoPager([], false, page, params);
        }
        const videos = items.map(function (item) { return buildPlatformVideo(item); });
        return new NASAVideoPager(videos, items.length >= ITEMS_PER_PAGE, page, params);
    } catch (e) {
        log("Failed to parse videos response: " + e.message);
        return new NASAVideoPager([], false, page, params);
    }
}

/**
 * Searches for videos using the WordPress REST API search parameter.
 * @param {string} query - Search query
 * @param {number} page - Page number (1-based)
 * @returns {NASASearchPager}
 */
function searchVideos(query, page, params) {
    params = params || {};

    if (!query || query.trim().length === 0) {
        return new NASASearchPager([], false, query, page, params);
    }

    let url = API_BASE_URL + "/video?per_page=" + ITEMS_PER_PAGE
        + "&page=" + page + "&search=" + encodeURIComponent(query)
        + "&orderby=relevance&order=desc";

    if (params.series) url += "&series=" + params.series;
    if (params.topic) url += "&topic=" + params.topic;

    const resp = httpGET({ url: url, parseResponse: true });
    if (!resp.isOk || !resp.body || !Array.isArray(resp.body)) {
        return new NASASearchPager([], false, query, page, params);
    }

    const videos = resp.body.map(function (item) { return buildPlatformVideo(item); });
    const hasMore = resp.body.length >= ITEMS_PER_PAGE;

    return new NASASearchPager(videos, hasMore, query, page, params);
}

/**
 * Builds a PlatformVideo from a WordPress video object.
 * @param {Object} item - WordPress video REST API object
 * @returns {PlatformVideo}
 */
function buildPlatformVideo(item) {
    const runtime = parseInt(item.meta?.["runtime"] || "0");
    const title = extractTitle(item);
    const isPreview = runtime > 0 && runtime < PREVIEW_RUNTIME_THRESHOLD && !title.toLowerCase().includes("trailer");

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, String(item.id), config.id),
        name: isPreview ? title + " (preview)" : title,
        thumbnails: buildThumbnails(item),
        author: nasaAuthor(),
        uploadDate: parseDate(item.date),
        duration: runtime,
        viewCount: 0,
        url: item.link || (BASE_URL + "/video/" + item.slug + "/"),
        isLive: false
    });
}

/**
 * Builds a PlatformVideoDetails from a WordPress video object.
 * @param {Object} item - WordPress video REST API object
 * @returns {PlatformVideoDetails}
 */
function buildVideoDetails(item) {
    const runtime = parseInt(item.meta?.["runtime"] || "0");
    const videoUrl = item.meta?.["video-url"] || "";
    const previewUrl = item.meta?.["preview-url"] || "";
    const title = extractTitle(item);
    const isPreview = runtime > 0 && runtime < PREVIEW_RUNTIME_THRESHOLD && !title.toLowerCase().includes("trailer");

    if (isPreview && settings.showPreviewToast !== false) {
        bridge.toast("Playing " + runtime + "-second preview. Disable this notification in plugin settings.");
    }

    const sources = [];
    if (videoUrl) {
        sources.push(new HLSSource({
            name: "HLS",
            duration: runtime,
            url: videoUrl
        }));
    }

    if (sources.length === 0 && previewUrl) {
        sources.push(new HLSSource({
            name: "Preview",
            duration: runtime,
            url: previewUrl
        }));
    }

    const description = buildDescription(item);

    const fields = {
        id: new PlatformID(PLATFORM, String(item.id), config.id),
        name: isPreview ? title + " (preview)" : title,
        thumbnails: buildThumbnails(item),
        author: nasaAuthor(),
        uploadDate: parseDate(item.date),
        duration: runtime,
        viewCount: 0,
        url: item.link || (BASE_URL + "/video/" + item.slug + "/"),
        isLive: false,
        description: description,
        video: new VideoSourceDescriptor(sources)
    };

    const result = new PlatformVideoDetails(fields);
    result.getContentRecommendations = function () {
        return source.getContentRecommendations(item.link || (BASE_URL + "/video/" + item.slug + "/"));
    };
    return result;
}

/**
 * Extracts plain text content from a WordPress item's content field.
 * @param {Object} item - WordPress REST API object
 * @returns {string} Plain text content
 */
function extractContent(item) {
    const rawContent = typeof item.content === "object" ? (item.content.rendered || "") : (item.content || "");
    return decodeHtmlEntities(rawContent).replace(/<[^>]*>/g, "").trim();
}

/**
 * Builds a description string from video metadata.
 * @param {Object} item - WordPress video REST API object
 * @returns {string}
 */
function buildDescription(item) {
    const parts = [];

    const content = extractContent(item);
    if (content) parts.push(content);

    const rating = item.meta?.["rating"];
    if (rating) parts.push("Rating: " + rating);

    const episode = item.meta?.["episode-num"];
    const season = item.meta?.["season"];
    if (season && episode) parts.push("Season " + season + ", Episode " + episode);
    else if (episode) parts.push("Episode " + episode);

    const featuring = item.meta?.["featuring"];
    if (featuring) parts.push("Featuring: " + featuring);

    const narratedBy = item.meta?.["narrated-by"];
    if (narratedBy) parts.push("Narrated by: " + narratedBy);

    const language = item.meta?.["language"] || item.meta?.["Language"];
    if (language) parts.push("Language: " + language);

    const seriesIds = item.series;
    if (seriesIds && seriesIds.length > 0) {

        parts.push("\n");

        const allSeries = fetchAllSeries();
        for (let i = 0; i < allSeries.length; i++) {
            if (allSeries[i].id === seriesIds[0]) {
                parts.push(allSeries[i].name + " - " + BASE_URL + "/series/" + allSeries[i].slug + "/");
                break;
            }
        }
    }

    return parts.join("\n");
}

/**
 * Builds a Thumbnails object from a video item.
 * @param {Object} item - WordPress video REST API object
 * @returns {Thumbnails}
 */
function buildThumbnails(item) {
    const imageUrl = item.featured_image || "";
    if (!imageUrl) return new Thumbnails([]);
    return new Thumbnails([new Thumbnail(imageUrl, 0)]);
}

/**
 * Parses an ISO 8601 date string to a Unix timestamp in seconds.
 * @param {string} dateStr - ISO 8601 date string
 * @returns {number} Unix timestamp in seconds, or 0 if parsing fails
 */
function parseDate(dateStr) {
    if (!dateStr) return 0;
    const ts = new Date(dateStr).getTime();
    return isNaN(ts) ? 0 : Math.floor(ts / 1000);
}

/**
 * Extracts the title string from a WordPress video object.
 * Handles both string and {rendered: "..."} formats.
 * @param {Object} item - WordPress video REST API object
 * @returns {string} Decoded title string
 */
function extractTitle(item) {
    const raw = typeof item.title === "object" ? (item.title.rendered || "") : (item.title || "");
    return decodeHtmlEntities(raw);
}

/**
 * Decodes HTML entities in a string.
 * @param {string} text - Text with HTML entities
 * @returns {string} Decoded text
 */
function decodeHtmlEntities(text) {
    if (!text) return "";
    return text
        .replace(/&#(\d+);/g, function (match, dec) { return String.fromCharCode(dec); })
        .replace(/&#x([0-9a-fA-F]+);/g, function (match, hex) { return String.fromCharCode(parseInt(hex, 16)); })
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'");
}

/**
 * Creates a PlatformAuthorLink for the NASA+ channel.
 * @returns {PlatformAuthorLink}
 */
function nasaAuthor() {
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, "nasa-plus", config.id),
        PLATFORM,
        BASE_URL,
        CHANNEL_THUMBNAIL_URL
    );
}

/**
 * Returns the main NASA+ channel.
 * @returns {PlatformChannel}
 */
function getNASAChannel() {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, "nasa-plus", config.id),
        name: PLATFORM,
        thumbnail: CHANNEL_THUMBNAIL_URL,
        banner: "",
        subscribers: 0,
        description: CHANNEL_DESCRIPTION,
        url: BASE_URL,
        links: {
            "Website": "https://www.nasa.gov",
            "YouTube": "https://www.youtube.com/nasa",
            "X": "https://x.com/nasa",
            "Instagram": "https://www.instagram.com/nasa/",
            "Facebook": "https://www.facebook.com/NASA/",
            "Twitch": "https://www.twitch.tv/nasa"
        }
    });
}

/**
 * Returns a channel for a NASA+ series.
 * @param {string} slug - Series slug
 * @returns {PlatformChannel}
 */
function getSeriesChannel(slug) {
    const series = findSeriesBySlug(slug);
    return buildSeriesChannelFromTaxonomy(series || { slug: slug, name: slug, description: "" });
}

/**
 * Builds a PlatformChannel from a series taxonomy object.
 * @param {Object} series - WordPress taxonomy term object
 * @returns {PlatformChannel}
 */
function buildSeriesChannelFromTaxonomy(series) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, "series-" + series.slug, config.id),
        name: series.name,
        thumbnail: CHANNEL_THUMBNAIL_URL,
        banner: "",
        subscribers: 0,
        description: series.description || "",
        url: BASE_URL + "/series/" + series.slug + "/",
        links: {}
    });
}

/**
 * Returns a channel for a NASA+ topic.
 * @param {string} slug - Topic slug
 * @returns {PlatformChannel}
 */
function getTopicChannel(slug) {
    const allTopics = fetchAllTopics();
    let topic = null;
    for (let i = 0; i < allTopics.length; i++) {
        if (allTopics[i].slug === slug) {
            topic = allTopics[i];
            break;
        }
    }

    return new PlatformChannel({
        id: new PlatformID(PLATFORM, "topic-" + slug, config.id),
        name: topic ? topic.name : slug,
        thumbnail: CHANNEL_THUMBNAIL_URL,
        banner: "",
        subscribers: 0,
        description: topic ? (topic.description || "") : "",
        url: BASE_URL + "/topics/" + slug + "/",
        links: {}
    });
}

/**
 * Fetches all series taxonomy terms with in-memory caching.
 * @returns {Object[]} Array of series taxonomy objects
 */
function fetchAllSeries() {
    if (state.series.length > 0 && (Date.now() - state.seriesFetchedAt < CACHE_TTL_MS)) {
        return state.series;
    }

    const resp = httpGET({ url: API_BASE_URL + "/series?per_page=100", parseResponse: true });
    if (!resp.isOk || !resp.body || !Array.isArray(resp.body)) {
        return state.series;
    }

    state.series = resp.body;
    state.seriesFetchedAt = Date.now();
    return state.series;
}

/**
 * Fetches all topic taxonomy terms with in-memory caching.
 * @returns {Object[]} Array of topic taxonomy objects
 */
function fetchAllTopics() {
    if (state.topics.length > 0 && (Date.now() - state.topicsFetchedAt < CACHE_TTL_MS)) {
        return state.topics;
    }

    const resp = httpGET({ url: API_BASE_URL + "/topic?per_page=100", parseResponse: true });
    if (!resp.isOk || !resp.body || !Array.isArray(resp.body)) {
        return state.topics;
    }

    state.topics = resp.body;
    state.topicsFetchedAt = Date.now();
    return state.topics;
}

/**
 * Finds a series taxonomy object by its slug.
 * @param {string} slug - Series slug
 * @returns {Object|null} Series taxonomy object or null if not found
 */
function findSeriesBySlug(slug) {
    const allSeries = fetchAllSeries();
    for (let i = 0; i < allSeries.length; i++) {
        if (allSeries[i].slug === slug) return allSeries[i];
    }
    return null;
}

/**
 * Finds a series taxonomy ID by its slug.
 * @param {string} slug - Series slug
 * @returns {number|null} Series ID or null if not found
 */
function findSeriesIdBySlug(slug) {
    const series = findSeriesBySlug(slug);
    return series ? series.id : null;
}

/**
 * Finds a topic taxonomy ID by its slug.
 * @param {string} slug - Topic slug
 * @returns {number|null} Topic ID or null if not found
 */
function findTopicIdBySlug(slug) {
    const allTopics = fetchAllTopics();
    for (let i = 0; i < allTopics.length; i++) {
        if (allTopics[i].slug === slug) return allTopics[i].id;
    }
    return null;
}

/**
 * Returns a single playlist for a series channel.
 * @param {string} slug - Series slug
 * @returns {NASAPlaylistPager}
 */
function getSeriesAsPlaylist(slug) {
    const series = findSeriesBySlug(slug);
    if (series) {
        return new NASAPlaylistPager([buildSeriesPlaylist(series)], false, []);
    }
    return new NASAPlaylistPager([], false, []);
}

/**
 * Returns all series as playlists, sorted by video count descending.
 * @returns {NASAPlaylistPager}
 */
function getSeriesPlaylists() {
    const allSeries = fetchAllSeries();
    const sorted = allSeries.slice().sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
    const playlists = sorted
        .filter(function (s) { return s.count > 0; })
        .map(function (s) { return buildSeriesPlaylist(s); });

    const firstPage = playlists.slice(0, ITEMS_PER_PAGE);
    const remaining = playlists.slice(ITEMS_PER_PAGE);
    return new NASAPlaylistPager(firstPage, remaining.length > 0, remaining);
}

/**
 * Returns series playlists filtered by topic.
 * Fetches videos for the topic to discover which series they belong to.
 * @param {string} topicSlug - Topic slug
 * @returns {NASAPlaylistPager}
 */
function getTopicSeriesPlaylists(topicSlug) {
    const topicId = findTopicIdBySlug(topicSlug);
    if (!topicId) {
        return new NASAPlaylistPager([], false, []);
    }

    const resp = httpGET({
        url: API_BASE_URL + "/video?per_page=100&topic=" + topicId,
        parseResponse: true
    });
    if (!resp.isOk || !resp.body || !Array.isArray(resp.body)) {
        return new NASAPlaylistPager([], false, []);
    }

    const seriesIdSet = {};
    for (let i = 0; i < resp.body.length; i++) {
        const seriesIds = resp.body[i].series;
        if (seriesIds) {
            for (let j = 0; j < seriesIds.length; j++) {
                seriesIdSet[seriesIds[j]] = true;
            }
        }
    }

    const allSeries = fetchAllSeries();
    const playlists = allSeries
        .filter(function (s) { return seriesIdSet[s.id] && s.count > 0; })
        .sort(function (a, b) { return (b.count || 0) - (a.count || 0); })
        .map(function (s) { return buildSeriesPlaylist(s); });

    return new NASAPlaylistPager(playlists, false, []);
}

/**
 * Builds a PlatformPlaylist from a series taxonomy object.
 * @param {Object} series - WordPress series taxonomy term
 * @returns {PlatformPlaylist}
 */
function buildSeriesPlaylist(series) {
    return new PlatformPlaylist({
        id: new PlatformID(PLATFORM, "series-" + series.slug, config.id),
        name: series.name,
        author: nasaAuthor(),
        thumbnail: PLUGIN_ICON_URL,
        url: BASE_URL + "/series/" + series.slug + "/",
        videoCount: series.count || -1
    });
}

/**
 * Fetches scheduled videos and returns live/upcoming ones as PlatformVideo objects.
 * Sorted: live events first, then upcoming events by start time ascending.
 * @returns {PlatformVideo[]}
 */
function fetchScheduledVideos() {
    const resp = http.GET(API_BASE_URL + "/scheduled_video?per_page=20&orderby=date&order=desc&_embed=wp:featuredmedia", REQUEST_HEADERS, false);
    return parseScheduledResponse(resp);
}

/**
 * Parses a raw HTTP response into an array of live/upcoming PlatformVideo objects.
 * Sorted: live events first, then upcoming events by start time ascending.
 * @param {Object} resp - Raw HTTP response
 * @returns {PlatformVideo[]}
 */
function parseScheduledResponse(resp) {
    if (!resp.isOk) return [];

    let items;
    try {
        items = JSON.parse(resp.body);
    } catch (e) {
        log("Failed to parse scheduled response: " + e.message);
        return [];
    }
    if (!Array.isArray(items)) return [];

    const nowSeconds = Math.floor(Date.now() / 1000);
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const startTime = parseInt(item.meta?.["first_aired_date"] || "0");
        const endTime = parseInt(item.meta?.["end_aired_date"] || "0");
        const isLive = startTime > 0 && nowSeconds >= startTime && nowSeconds <= endTime;
        const isUpcoming = startTime > 0 && nowSeconds < startTime;

        if (isLive || isUpcoming) {
            results.push(buildScheduledPlatformVideo(item, isLive));
        }
    }

    results.sort(function (a, b) {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return (a.datetime || 0) - (b.datetime || 0);
    });

    return results;
}

/**
 * Extracts the thumbnail URL from a scheduled video's embedded featured media.
 * @param {Object} item - WordPress scheduled_video REST API object with _embedded
 * @returns {string} Thumbnail URL or empty string
 */
function getScheduledThumbnailUrl(item) {
    return item._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
}

/**
 * Builds a PlatformVideo from a scheduled video object.
 * @param {Object} item - WordPress scheduled_video REST API object
 * @param {boolean} isLive - Whether the event is currently live
 * @returns {PlatformVideo}
 */
function buildScheduledPlatformVideo(item, isLive) {
    const title = extractTitle(item);
    const startTime = parseInt(item.meta?.["first_aired_date"] || "0");
    const endTime = parseInt(item.meta?.["end_aired_date"] || "0");
    const duration = (startTime > 0 && endTime > 0) ? endTime - startTime : 0;

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, "scheduled-" + String(item.id), config.id),
        name: title,
        thumbnails: buildThumbnails({ featured_image: getScheduledThumbnailUrl(item) }),
        author: nasaAuthor(),
        uploadDate: startTime,
        duration: isLive ? 0 : duration,
        viewCount: 0,
        url: item.link || (BASE_URL + "/scheduled-video/" + item.slug + "/"),
        isLive: isLive
    });
}

/**
 * Builds a PlatformVideoDetails from a scheduled video object.
 * @param {Object} item - WordPress scheduled_video REST API object
 * @returns {PlatformVideoDetails}
 */
function buildScheduledVideoDetails(item) {
    const title = extractTitle(item);
    const videoUrl = item.meta?.["video-url"] || "";
    const startTime = parseInt(item.meta?.["first_aired_date"] || "0");
    const endTime = parseInt(item.meta?.["end_aired_date"] || "0");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const isLive = startTime > 0 && nowSeconds >= startTime && nowSeconds <= endTime;
    const duration = (startTime > 0 && endTime > 0) ? endTime - startTime : 0;

    const fields = {
        id: new PlatformID(PLATFORM, "scheduled-" + String(item.id), config.id),
        name: title,
        thumbnails: buildThumbnails({ featured_image: getScheduledThumbnailUrl(item) }),
        author: nasaAuthor(),
        uploadDate: startTime,
        duration: isLive ? 0 : duration,
        viewCount: 0,
        url: item.link || (BASE_URL + "/scheduled-video/" + item.slug + "/"),
        isLive: isLive,
        description: extractContent(item),
        video: new VideoSourceDescriptor([])
    };

    if (isLive && videoUrl) {
        fields.live = new HLSSource({
            name: "Live",
            duration: 0,
            url: videoUrl
        });
    } else if (videoUrl) {
        fields.video = new VideoSourceDescriptor([
            new HLSSource({
                name: "HLS",
                duration: duration,
                url: videoUrl
            })
        ]);
    }

    return new PlatformVideoDetails(fields);
}

/**
 * Builds PlatformVideo objects from a video's related_videos array.
 * @param {Object} video - WordPress video REST API object with related_videos
 * @returns {PlatformVideo[]}
 */
function buildRelatedVideos(video) {
    if (!video.related_videos || !Array.isArray(video.related_videos)) return [];

    return video.related_videos
        .filter(function (rv) { return rv.ID !== video.id && rv.permalink; })
        .map(function (rv) {
            const runtime = parseInt(rv.meta?.["runtime"] || "0");
            const title = decodeHtmlEntities(rv.post_title || "");

            return new PlatformVideo({
                id: new PlatformID(PLATFORM, String(rv.ID), config.id),
                name: title,
                thumbnails: rv.meta?.["featured-image"]
                    ? new Thumbnails([new Thumbnail(rv.meta["featured-image"], 0)])
                    : new Thumbnails([]),
                author: nasaAuthor(),
                uploadDate: parseDate(rv.post_date_gmt),
                duration: runtime,
                viewCount: 0,
                url: rv.permalink,
                isLive: false
            });
        });
}

log("loaded");
