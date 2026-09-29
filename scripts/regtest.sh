#!/bin/sh
# A private Monero chain for maki desktop's Monero tests: monerod in regtest mode, offline, its
# RPC on 127.0.0.1:28081, and monero-wallet-rpc on 28083, with 130 blocks mined to the BIP39 test
# phrase's wallet (the fake maki's), so it has coins to spend (a coinbase output waits 60 blocks).
# Then `MAKI_REGTEST=1 npm test`, MONERO_BIN set too for the test through monero-wallet-cli.
#
# MONERO_BIN: where monerod and monero-wallet-rpc are (Monero's own release, getmonero.org),
# else they're looked for on the PATH. DATA: where the chain and the wallets go, else a new
# temporary folder. Stop them with `kill $(cat $DATA/*.pid)`.
set -eu
BIN=${MONERO_BIN:-$(dirname "$(command -v monerod)")}
DATA=${DATA:-$(mktemp -d -t maki-regtest.XXXXXX)}
TEST_PHRASE_WALLET=49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn
mkdir -p "$DATA/node" "$DATA/wallets"

"$BIN/monerod" --regtest --offline --fixed-difficulty 1 --data-dir "$DATA/node" \
  --rpc-bind-ip 127.0.0.1 --rpc-bind-port 28081 --p2p-bind-ip 127.0.0.1 --p2p-bind-port 28080 \
  --no-zmq --non-interactive --detach --pidfile "$DATA/monerod.pid"
until curl -s -o /dev/null http://127.0.0.1:28081/get_height; do sleep 1; done

"$BIN/monero-wallet-rpc" --daemon-address 127.0.0.1:28081 --trusted-daemon \
  --allow-mismatched-daemon-version --rpc-bind-ip 127.0.0.1 --rpc-bind-port 28083 \
  --wallet-dir "$DATA/wallets" --disable-rpc-login --non-interactive --detach \
  --pidfile "$DATA/wallet-rpc.pid"

curl -s http://127.0.0.1:28081/json_rpc -H 'Content-Type: application/json' -d \
  "{\"jsonrpc\":\"2.0\",\"id\":\"0\",\"method\":\"generateblocks\",\"params\":{\"amount_of_blocks\":130,\"wallet_address\":\"$TEST_PHRASE_WALLET\"}}" \
  > /dev/null
echo "regtest in $DATA: monerod on 28081, monero-wallet-rpc on 28083"
