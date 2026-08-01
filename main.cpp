#include <iostream>
#include <string>
#include <queue>
#include <unordered_map>
#include <vector>
#include <curl/curl.h>
// Assuming json.hpp is in the same directory or your include path
#include "json.hpp" 
#include <chrono> // For measuring execution time

using json = nlohmann::json;
using namespace std;

// 1. Define the Adjacency List for our City Grid
unordered_map<string, vector<pair<string, int>>> cityGraph;

// 2. Build the initial map
void setupGraph() {
    // Road connections and base travel times (in minutes)
    cityGraph["Warehouse"].push_back({"Downtown", 15});
    cityGraph["Downtown"].push_back({"Warehouse", 15});
    
    cityGraph["Downtown"].push_back({"Delivery_Zone", 10});
    cityGraph["Delivery_Zone"].push_back({"Downtown", 10});
    
    // An alternate, normally slower highway route
    cityGraph["Warehouse"].push_back({"Highway", 20});
    cityGraph["Highway"].push_back({"Warehouse", 20});
    
    cityGraph["Highway"].push_back({"Delivery_Zone", 20});
    cityGraph["Delivery_Zone"].push_back({"Highway", 20});
}

// 3. Dijkstra's Algorithm using a Min-Heap
void runDijkstra(string start, string end) {
    priority_queue<pair<int, string>, vector<pair<int, string>>, greater<pair<int, string>>> pq;
    unordered_map<string, int> dist;
    
    // Initialize all distances to infinity
    for (auto& pair : cityGraph) dist[pair.first] = 1e9;
    
    pq.push({0, start});
    dist[start] = 0;
    
    while (!pq.empty()) {
        int d = pq.top().first;
        string u = pq.top().second;
        pq.pop();
        
        if (d > dist[u]) continue;
        
        for (auto& edge : cityGraph[u]) {
            string v = edge.first;
            int weight = edge.second;
            
            if (dist[u] + weight < dist[v]) {
                dist[v] = dist[u] + weight;
                pq.push({dist[v], v});
            }
        }
    }
    cout << "\n[ROUTE CALCULATED] Fastest path from " << start << " to " << end << " is currently " << dist[end] << " minutes.\n";
}

// libcurl requires a callback function to handle the incoming data stream.
// This function appends the raw byte chunks from the internet into our C++ std::string.
size_t WriteCallback(void* contents, size_t size, size_t nmemb, string* userp) {
    size_t totalSize = size * nmemb;
    userp->append((char*)contents, totalSize);
    return totalSize;
}

int main() {
    setupGraph();

    // Start a high-resolution timer to measure network vs parsing overhead
    auto start_time = chrono::high_resolution_clock::now();

    CURL* curl;
    CURLcode res;
    string readBuffer; // This will hold the raw JSON string

    // 1. Initialize libcurl
    curl = curl_easy_init();
    if(curl) {
        // 1. Target your Node.js API Gateway directly
        string apiUrl = "http://localhost:3000/api/alerts";
        
        curl_easy_setopt(curl, CURLOPT_URL, apiUrl.c_str());
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &readBuffer);
        
        // (We completely deleted the SSL bypass lines because localhost uses standard HTTP)

        res = curl_easy_perform(curl);
        
        if(res != CURLE_OK) {
            cerr << "curl_easy_perform() failed: " << curl_easy_strerror(res) << endl;
        } else {
            try {
                // 2. Parse the JSON array coming from Node.js
                json alertsData = json::parse(readBuffer);
                
                cout << "Successfully fetched live data from Node.js API Gateway!" << endl;
                cout << "Active alerts pending route calculation: " << alertsData.size() << endl;

                // Loop through the alerts from Node.js
                for (auto& alert : alertsData) {
                    string vehicle = alert["vehicleId"];
                    string issue = alert["issue"];
                    int val = alert["value"];

                    cout << "[Live Data] Vehicle " << vehicle 
                         << " flagged for " << issue << " (" << val << "). ";

                    // If a vehicle is speeding or crashing downtown, traffic slows down!
                    if (issue == "Speeding" || issue == "Low Fuel") {
                        cout << "Increasing Downtown traffic weight +5 mins..." << endl;
                        
                        // Find the Downtown -> Delivery_Zone edge and increase its weight
                        for (auto& edge : cityGraph["Downtown"]) {
                            if (edge.first == "Delivery_Zone") {
                                edge.second += 5; 
                            }
                        }
                    }
                }

                // After all alerts modify the map, recalculate the fastest route!
                runDijkstra("Warehouse", "Delivery_Zone");
            }
            catch (json::parse_error& e) {
                cerr << "JSON parsing error: " << e.what() << '\n';
            }
        }
        curl_easy_cleanup(curl);
    }

    auto end_time = chrono::high_resolution_clock::now();
    auto duration = chrono::duration_cast<chrono::microseconds>(end_time - start_time);
    cout << "\nTotal execution time (Network + Parsing): " << duration.count() << " microseconds." << endl;

    return 0;
}