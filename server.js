"use strict";

/*
 * TIC-TAC-∞ multiplayer server.
 *
 * Responsibilities:
 *  - Simple 1v1 matchmaking queue (no accounts, no rooms — MVP scope)
 *  - Server-authoritative game state via rules.js (identical logic to
 *    the client, so the two can never disagree about a result)
 *  - Disconnect handling (opponent is notified and awarded the win)
 *
 * This is intentionally framework-free (plain `ws` + `http`) so it can
 * be deployed anywhere that runs Node: Render, Railway, Fly.io, Glitch,
 * or your own VPS behind a reverse proxy.
 *
 * IMPORTANT: CrazyGames (and most browsers) serve pages over HTTPS, and
 * an HTTPS page cannot open an insecure `ws://` connection — it must be
 * `wss://`. Any host that terminates TLS for you (Render/Railway/Fly/etc)
 * gives you a wss:// URL automatically. If you self-host, put this
 * behind nginx/Caddy with a TLS certificate.
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { createInitialState, placeMove } = require("./rules");

const PORT = process.env.PORT || 8081;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("TIC-TAC-INFINITY multiplayer server is running.\n");
});

const wss = new WebSocketServer({ server: httpServer });

/** @type {Map<WebSocket, {id:number, name:string, matchId:string|null}>} */
const clients = new Map();

/** Player currently waiting for an opponent, or null. */
let waitingPlayer = null;

/** @type {Map<string, {players:{X:WebSocket,O:WebSocket}, names:{X:string,O:string}, state:object}>} */
const matches = new Map();

let nextClientId = 1;

function send(ws, payload){
    if(ws && ws.readyState === ws.OPEN){
        try{ ws.send(JSON.stringify(payload)); }catch(error){}
    }
}

function randomMatchId(){
    return "m_" + Math.random().toString(36).slice(2, 10);
}

function guestName(id){
    return "PLAYER_" + (1000 + (id % 9000));
}

function endMatch(matchId, reason, winnerSymbol){
    const match = matches.get(matchId);
    if(!match) return;

    match.state.status = "finished";
    if(winnerSymbol) match.state.winner = winnerSymbol;

    ["X", "O"].forEach(symbol => {
        const ws = match.players[symbol];
        send(ws, {
            type: "game_end",
            reason,                    // "line" | "draw" | "disconnect" | "forfeit"
            winner: match.state.winner,
            winningLine: match.state.winningLine
        });

        const info = clients.get(ws);
        if(info) info.matchId = null;
    });

    matches.delete(matchId);
}

function tryMatchmaking(ws){
    if(waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === waitingPlayer.OPEN){
        const matchId = randomMatchId();
        const a = waitingPlayer;
        const b = ws;
        waitingPlayer = null;

        const infoA = clients.get(a);
        const infoB = clients.get(b);

        const state = createInitialState();

        matches.set(matchId, {
            players: { X: a, O: b },
            names: { X: infoA.name, O: infoB.name },
            state
        });

        infoA.matchId = matchId;
        infoB.matchId = matchId;

        send(a, { type:"match_found", matchId, you:{ symbol:"X", name:infoA.name }, opponent:{ name:infoB.name } });
        send(b, { type:"match_found", matchId, you:{ symbol:"O", name:infoB.name }, opponent:{ name:infoA.name } });

        /* Small delay so both clients can play their 3-2-1-GO countdown
           before the board actually becomes interactive. */
        setTimeout(() => {
            const payload = {
                type: "game_start",
                matchId,
                board: state.board,
                currentPlayer: state.currentPlayer,
                turn: state.turn
            };
            send(a, payload);
            send(b, payload);
        }, 1600);

    }else{
        waitingPlayer = ws;
        send(ws, { type:"queued" });
    }
}

function cancelQueue(ws){
    if(waitingPlayer === ws) waitingPlayer = null;
    send(ws, { type:"queue_cancelled" });
}

function handleMove(ws, msg){
    const info = clients.get(ws);
    if(!info || !info.matchId) return;

    const match = matches.get(info.matchId);
    if(!match) return;

    const symbol = match.players.X === ws ? "X" : match.players.O === ws ? "O" : null;
    if(!symbol) return;

    const result = placeMove(match.state, symbol, msg.cell);

    if(!result.valid){
        send(ws, { type:"move_rejected", reason: result.reason });
        return;
    }

    const payload = {
        type: "state_update",
        board: result.board,
        moves: result.moves,
        currentPlayer: result.currentPlayer,
        turn: result.turn,
        status: result.status,
        winner: result.winner,
        winningLine: result.winningLine,
        placedCell: result.placedCell,
        removedCell: result.removedCell,
        movedBy: symbol
    };

    send(match.players.X, payload);
    send(match.players.O, payload);

    if(result.status === "finished"){
        setTimeout(() => endMatch(info.matchId, "line", result.winner), 50);
    }
}

function handleLeave(ws){
    const info = clients.get(ws);
    if(!info || !info.matchId) return;

    const match = matches.get(info.matchId);
    if(!match) return;

    const opponentSymbol = match.players.X === ws ? "O" : "X";
    endMatch(info.matchId, "forfeit", opponentSymbol);
}

wss.on("connection", (ws) => {
    const id = nextClientId++;
    clients.set(ws, { id, name: guestName(id), matchId: null });

    ws.on("message", (raw) => {
        let msg;
        try{ msg = JSON.parse(raw); }catch(error){ return; }

        switch(msg.type){
            case "find_match": tryMatchmaking(ws); break;
            case "cancel_find": cancelQueue(ws); break;
            case "move": handleMove(ws, msg); break;
            case "leave": handleLeave(ws); break;
            case "ping": send(ws, { type:"pong" }); break;
        }
    });

    ws.on("close", () => {
        if(waitingPlayer === ws) waitingPlayer = null;

        const info = clients.get(ws);
        if(info && info.matchId){
            const match = matches.get(info.matchId);
            if(match){
                const opponentSymbol = match.players.X === ws ? "O" : "X";
                const opponentWs = match.players[opponentSymbol];
                send(opponentWs, { type:"opponent_disconnected" });
                endMatch(info.matchId, "disconnect", opponentSymbol);
            }
        }

        clients.delete(ws);
    });

    ws.on("error", () => {});
});

httpServer.listen(PORT, () => {
    console.log(`TIC-TAC-INFINITY multiplayer server listening on :${PORT}`);
});
