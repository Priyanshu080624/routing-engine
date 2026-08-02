#include <iostream>
#include <string>
#include <queue>
#include <unordered_map>
#include <vector>
#include <fstream>
#include <sstream>
#include <curl/curl.h>
#include "json.hpp"
#include <chrono>

using json = nlohmann::json;
using namespace std;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
struct Edge {
    string to;       // destination node key (e.g. "12.9663,77.6147")
    string road;     // road name
    string highway;  // road type
    double weight;   // travel time in minutes
};

struct Coord { double lat, lon; };

// ─────────────────────────────────────────────────────────────
// Real Bengaluru graph loaded from city_graph.json
// node key format: "lat.toFixed(4),lon.toFixed(4)"
// ─────────────────────────────────────────────────────────────
unordered_map<string, vector<Edge>> cityGraph;
unordered_map<string, Coord>        nodeCoords;   // key → {lat,lon}

// ─────────────────────────────────────────────────────────────
// Named "stations" — mapped to real node keys via snapKey
// Coordinates come from city_landmarks.json midpoints
// ─────────────────────────────────────────────────────────────
struct Station { string name; string nodeKey; Coord coord; };

// Snap a lat/lon to the same 4-decimal key the parser used
string snapKey(double lat, double lon) {
    ostringstream oss;
    oss << fixed;
    oss.precision(4);
    oss << lat << "," << lon;
    return oss.str();
}

// Find the nearest node key in the graph to a given coordinate
// (used because landmark midpoints may land between two snapped nodes)
string findNearestNode(double lat, double lon) {
    double bestDist = 1e18;
    string bestKey  = "";

    double targetKey_lat = round(lat * 10000) / 10000.0;
    double targetKey_lon = round(lon * 10000) / 10000.0;

    // First try exact snap
    string exact = snapKey(targetKey_lat, targetKey_lon);
    if (cityGraph.count(exact)) return exact;

    // Fallback: scan within 0.005 degree (~550m) bounding box
    for (auto& [k, _] : cityGraph) {
        auto& c = nodeCoords[k];
        double dlat = c.lat - lat;
        double dlon = c.lon - lon;
        double dist = dlat*dlat + dlon*dlon;
        if (dist < bestDist) { bestDist = dist; bestKey = k; }
    }
    return bestKey;
}

// ─────────────────────────────────────────────────────────────
// Load city_graph.json into the adjacency list
// ─────────────────────────────────────────────────────────────
bool loadGraph(const string& graphFile) {
    cout << "[Graph] Loading " << graphFile << " ...\n";
    auto t0 = chrono::high_resolution_clock::now();

    ifstream f(graphFile);
    if (!f.is_open()) {
        cerr << "[Graph] ERROR: Cannot open " << graphFile << "\n";
        return false;
    }

    json j;
    try { f >> j; }
    catch (json::parse_error& e) {
        cerr << "[Graph] JSON parse error: " << e.what() << "\n";
        return false;
    }

    for (auto& [nodeKey, edges] : j.items()) {
        // Parse lat,lon from the key
        auto comma = nodeKey.find(',');
        double lat = stod(nodeKey.substr(0, comma));
        double lon = stod(nodeKey.substr(comma + 1));
        nodeCoords[nodeKey] = { lat, lon };

        vector<Edge> edgeList;
        edgeList.reserve(edges.size());
        for (auto& e : edges) {
            edgeList.push_back({
                e["to"].get<string>(),
                e.value("road",    ""),
                e.value("highway", ""),
                e["weight"].get<double>()
            });
        }
        cityGraph[nodeKey] = move(edgeList);
    }

    auto t1 = chrono::high_resolution_clock::now();
    auto ms  = chrono::duration_cast<chrono::milliseconds>(t1 - t0).count();
    cout << "[Graph] Loaded " << cityGraph.size() << " nodes in " << ms << " ms\n";
    return true;
}

// ─────────────────────────────────────────────────────────────
// Dijkstra on the real graph
// Returns {duration_minutes, ordered_path_of_node_keys}
// ─────────────────────────────────────────────────────────────
pair<double, vector<string>> runDijkstra(const string& start, const string& end) {
    using PQ = priority_queue<pair<double,string>, vector<pair<double,string>>, greater<>>;
    PQ pq;
    unordered_map<string, double> dist;
    unordered_map<string, string> parent;

    // Init all known nodes to infinity
    for (auto& [k, _] : cityGraph) dist[k] = 1e18;
    dist[start] = 0.0;
    pq.push({0.0, start});

    while (!pq.empty()) {
        auto [d, u] = pq.top(); pq.pop();
        if (d > dist[u] + 1e-9) continue;
        if (u == end) break;  // early exit

        for (auto& e : cityGraph[u]) {
            double nd = dist[u] + e.weight;
            if (nd < dist[e.to]) {
                dist[e.to]   = nd;
                parent[e.to] = u;
                pq.push({nd, e.to});
            }
        }
    }

    if (dist.find(end) == dist.end() || dist[end] >= 1e17) {
        return {-1, {}};
    }

    // Reconstruct path
    vector<string> path;
    for (string cur = end; cur != start; ) {
        path.push_back(cur);
        if (!parent.count(cur)) return {-1, {}};
        cur = parent[cur];
    }
    path.push_back(start);
    reverse(path.begin(), path.end());
    return {dist[end], path};
}

// ─────────────────────────────────────────────────────────────
// libcurl helpers
// ─────────────────────────────────────────────────────────────
size_t WriteCallback(void* contents, size_t size, size_t nmemb, string* userp) {
    userp->append((char*)contents, size * nmemb);
    return size * nmemb;
}

string httpGet(const string& url) {
    CURL* curl = curl_easy_init();
    string buf;
    if (!curl) return buf;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    return buf;
}

void postJson(const string& url, const string& body) {
    CURL* curl = curl_easy_init();
    if (!curl) return;
    struct curl_slist* hdrs = nullptr;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    string resp;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);
    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK)
        cerr << "[POST] curl error: " << curl_easy_strerror(res) << "\n";
    else
        cout << "[POST /api/route] " << resp << "\n";
    curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
int main() {
    auto total_start = chrono::high_resolution_clock::now();

    // ── 1. Load real Bengaluru graph ──────────────────────────
    // Resolve path relative to this executable's location
    string graphFile = "city_graph.json";
    if (!loadGraph(graphFile)) return 1;

    // ── 2. Define named stations from real landmark midpoints ──
    // Coordinates from city_landmarks.json (same as simulator.js)
    vector<Station> stations = {
        { "Brigade_Road",    snapKey(12.97003, 77.60661), {12.97003, 77.60661} },
        { "Victoria_Road",   snapKey(12.96628, 77.61474), {12.96628, 77.61474} },
        { "Kasturba_Road",   snapKey(12.96780, 77.58788), {12.96780, 77.58788} },
        { "Domlur_Flyover",  snapKey(12.96045, 77.64175), {12.96045, 77.64175} },
        { "JC_Road",         snapKey(12.95622, 77.58106), {12.95622, 77.58106} },
        { "Lalbagh_Road",    snapKey(12.95521, 77.58565), {12.95521, 77.58565} },
        { "KH_Road",         snapKey(12.95184, 77.59057), {12.95184, 77.59057} },
        { "Bannerghatta_Rd", snapKey(12.89860, 77.60040), {12.89860, 77.60040} },
        { "Outer_Ring_Road", snapKey(12.90625, 77.59493), {12.90625, 77.59493} },
    };

    // Resolve each station to its nearest actual graph node key
    cout << "\n[Stations] Resolving to nearest graph nodes:\n";
    for (auto& s : stations) {
        s.nodeKey = findNearestNode(s.coord.lat, s.coord.lon);
        cout << "  " << s.name << " → " << s.nodeKey << "\n";
    }

    // ── 3. Fetch live alerts from Node.js API ─────────────────
    cout << "\n[Alerts] Fetching from http://localhost:3000/api/alerts ...\n";
    string alertsRaw = httpGet("http://localhost:3000/api/alerts");

    string startKey = stations[0].nodeKey;  // Brigade Road (default)
    string endKey   = stations[7].nodeKey;  // Bannerghatta Road (default)
    string startName = stations[0].name;
    string endName   = stations[7].name;

    try {
        json alertsData = json::parse(alertsRaw);
        cout << "[Alerts] " << alertsData.size() << " active alerts\n";

        // Routing logic: if speeding alerts near Domlur, reroute to Kasturba corridor
        int speedingCount = 0;
        for (auto& a : alertsData) {
            if (a["issue"] == "Speeding") speedingCount++;
        }

        if (speedingCount >= 2) {
            cout << "[Engine] High traffic detected (" << speedingCount
                 << " speeding) — rerouting via Kasturba corridor\n";
            startKey  = stations[0].nodeKey;  // Brigade
            endKey    = stations[7].nodeKey;  // Bannerghatta
            startName = "Brigade_Road";
            endName   = "Bannerghatta_Road";
        } else {
            cout << "[Engine] Normal traffic — computing direct route\n";
            startKey  = stations[0].nodeKey;  // Brigade
            endKey    = stations[3].nodeKey;  // Domlur
            startName = "Brigade_Road";
            endName   = "Domlur_Flyover";
        }
    }
    catch (json::parse_error& e) {
        cerr << "[Alerts] JSON error: " << e.what() << "\n";
    }

    // ── 4. Run Dijkstra on real Bengaluru graph ───────────────
    cout << "\n[Dijkstra] " << startName << " → " << endName << "\n";
    auto t0 = chrono::high_resolution_clock::now();
    auto [duration, path] = runDijkstra(startKey, endKey);
    auto t1 = chrono::high_resolution_clock::now();
    auto dijkMs = chrono::duration_cast<chrono::milliseconds>(t1 - t0).count();

    if (duration < 0 || path.empty()) {
        cerr << "[Dijkstra] No path found between stations!\n";
        return 1;
    }

    cout << "[Dijkstra] Done in " << dijkMs << " ms\n";
    cout << "[Dijkstra] Duration: " << fixed << setprecision(1) << duration << " minutes\n";
    cout << "[Dijkstra] Path hops: " << path.size() << " nodes\n";

    // ── 5. Build coordinate list from path ────────────────────
    // Sample every Nth node to keep the frontend polyline manageable
    const int SAMPLE = max(1, (int)(path.size() / 200));  // ~200 points max
    json coordsArray = json::array();
    for (size_t i = 0; i < path.size(); i += SAMPLE) {
        const string& k = path[i];
        if (nodeCoords.count(k)) {
            coordsArray.push_back({
                {"lat", nodeCoords[k].lat},
                {"lon", nodeCoords[k].lon}
            });
        }
    }
    // Always include endpoint
    if (!path.empty() && nodeCoords.count(path.back())) {
        coordsArray.push_back({
            {"lat", nodeCoords[path.back()].lat},
            {"lon", nodeCoords[path.back()].lon}
        });
    }

    // ── 6. POST route result to Node.js → WebSocket → frontend
    json routePayload = {
        {"from",        startName},
        {"to",          endName},
        {"duration",    round(duration * 10) / 10.0},
        {"hops",        (int)path.size()},
        {"coordinates", coordsArray}
    };

    cout << "\n[POST] Sending route to Node.js → frontend map ...\n";
    postJson("http://localhost:3000/api/route", routePayload.dump());

    // ── 7. Timing ─────────────────────────────────────────────
    auto total_end = chrono::high_resolution_clock::now();
    auto totalMs   = chrono::duration_cast<chrono::milliseconds>(total_end - total_start).count();
    cout << "\n[Timing] Total: " << totalMs << " ms"
         << " | Graph load + Dijkstra on " << cityGraph.size()
         << " real Bengaluru nodes\n";

    return 0;
}