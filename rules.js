"use strict";

/*
 * Authoritative rules engine for TIC-TAC-∞.
 *
 * This MUST stay logically identical to the client's placeMove()
 * in index.html. The server is the source of truth — clients only
 * render whatever state this function produces.
 *
 * Mandatory order, never change it:
 *   1. PLACE the mark
 *   2. CHECK WIN
 *   3. IF WIN -> stop here, do NOT remove anything
 *   4. IF NOT WIN and the mover now has 4+ marks -> remove the oldest
 *   5. Advance to the next player's turn
 */

const WIN_LINES = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
];

function getWinningLine(board, player){
    for(const line of WIN_LINES){
        if(line.every(i => board[i] === player)) return line;
    }
    return null;
}

function createInitialState(){
    return {
        board: Array(9).fill(null),
        moves: { X: [], O: [] },
        currentPlayer: "X",
        turn: 1,
        status: "playing",
        winner: null,
        winningLine: null
    };
}

/**
 * RulesEngine.placeMove(state, player, cell)
 * Mutates `state` in place and returns a result descriptor.
 * Returns { valid:false, reason } if the move is illegal —
 * the server must never trust a client-submitted move blindly.
 */
function placeMove(state, player, cell){
    if(state.status !== "playing"){
        return { valid:false, reason:"game_finished" };
    }

    if(player !== state.currentPlayer){
        return { valid:false, reason:"not_your_turn" };
    }

    if(typeof cell !== "number" || cell < 0 || cell > 8 || state.board[cell] !== null){
        return { valid:false, reason:"illegal_cell" };
    }

    /* STEP 1 — place */
    state.board[cell] = player;
    state.moves[player].push({ cell, turn: state.turn });

    /* STEP 2 — check win BEFORE any removal */
    const winningLine = getWinningLine(state.board, player);
    let removedCell = null;

    if(winningLine){
        /* STEP 3 — win: end the game, no removal, ever */
        state.winner = player;
        state.winningLine = winningLine;
        state.status = "finished";
    }else{
        /* STEP 4 — no win: enforce the ∞ rule if this is the 4th+ mark */
        if(state.moves[player].length > 3){
            const oldest = state.moves[player].shift();
            removedCell = oldest.cell;
            state.board[removedCell] = null;
        }

        /* STEP 5 — next player's turn */
        state.turn += 1;
        state.currentPlayer = player === "X" ? "O" : "X";
    }

    return {
        valid: true,
        winner: state.winner,
        winningLine: state.winningLine,
        placedCell: cell,
        removedCell,
        board: [...state.board],
        moves: { X: [...state.moves.X], O: [...state.moves.O] },
        currentPlayer: state.currentPlayer,
        turn: state.turn,
        status: state.status
    };
}

module.exports = { WIN_LINES, getWinningLine, createInitialState, placeMove };
