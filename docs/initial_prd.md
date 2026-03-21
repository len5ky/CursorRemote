Prototype Scope Document: Cursor Web Controller (MVP)
1. Objective
Build a Node.js relay server that connects to a locally running Cursor IDE instance via Chromium DevTools Protocol (CDP). The server will extract the AI Chat panel's DOM, broadcast it to a lightweight web client via WebSockets, and proxy remote user interactions back to the IDE.

2. System Architecture

Host Process: Standard Cursor IDE launched with --remote-debugging-port=9222.

Relay Server (Node.js): * Runs locally on the same machine as Cursor.

Maintains a CDP connection to Cursor using puppeteer-core.

Serves the static HTML/JS for the frontend UI.

Hosts a WebSocket server (e.g., using socket.io or ws) to maintain a real-time bi-directional link with the web client.

Web Client (Browser):

Receives raw HTML or state updates via WebSockets and renders the chat interface.

Captures user keystrokes and button clicks, sending them as structured JSON payloads over the WebSocket back to the Relay Server.

3. Core Requirements (MVP)

Requirement 1: Server Initialization

The Node server must successfully bind to http://localhost:9222/json, find the Cursor workspace, and attach Puppeteer.

It must simultaneously start an Express server (e.g., on port 3000) to serve the client interface.

Requirement 2: State Broadcasting

The backend must monitor the Cursor DOM.

Upon detecting a change in the Secondary Side Bar, it must serialize the relevant HTML content and broadcast it to all connected WebSocket clients.

Requirement 3: Command Routing

The backend must listen for specific WebSocket events from the client:

chat_input: Contains a string. The backend executes page.keyboard.type() within the Cursor target.

trigger_click: Contains a target identifier (like "submit" or "approve"). The backend maps this to the corresponding DOM selector and executes page.click().

Requirement 4: Client-Side Rendering

The web client must replace its container's innerHTML with the broadcasted HTML string.

It must inject basic CSS to ensure the unstyled Cursor HTML is legible on a mobile or remote browser.

4. Implementation Phases

Phase 1: The Relay Hub

Initialize the Node.js project. Set up Express to serve a basic index.html and establish the WebSocket server.

Phase 2: The CDP Bridge

Integrate puppeteer-core into the Node server. Write the polling logic to grab the chat container's HTML every second (or via MutationObserver) and emit it over the WebSocket.

Phase 3: The Web Client

Write the frontend JavaScript to listen for WebSocket messages and render the injected HTML.

Add an input field and send button to the web UI that emits chat_input events back to the server.

Phase 4: The Execution Loop

Write the backend handlers to receive the WebSocket events and translate them into Puppeteer interactions inside Cursor.

5. Engineering Risks & Mitigations

Risk: High Frequency DOM Updates. Cursor streams text token-by-token. Broadcasting the entire chat container HTML on every single token update will cause severe network overhead and client-side rendering flicker.

Mitigation: Implement a debounce function on the backend DOM observer. Only broadcast state changes every 300-500ms, or parse the DOM and only send the newest text diff rather than the entire HTML blob.

Risk: Event Listener Loss. When extracting HTML using innerHTML, the associated JavaScript event listeners tied to Cursor's React state are destroyed.

Mitigation: The web client cannot rely on clicking the extracted HTML buttons directly. The web UI must render its own static control buttons (e.g., a dedicated "Approve" button floating at the bottom of the screen) that trigger the WebSocket events, rather than trying to make the cloned DOM interactive.