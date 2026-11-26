#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077

genesis=00006e037d7b84104208ecf2a8638d23149d712ea810da604ee2f2cb39bae713
alphabet=123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
max_u64=18446744073709551615
reserve=${WGRC_TESTNET_RESERVE_ADDRESS:-}
cli=( "${GRC_CLI:-gridcoinresearchd}" -testnet )
if [[ -n ${GRC_CONF:-} ]]; then cli+=( "-conf=$GRC_CONF" ); fi

usage() {
  cat <<'EOF'
Usage: wgrc-deposit.sh AMOUNT_GRC --solana-address ADDRESS
       wgrc-deposit.sh retry DEPOSIT_JSON_FILE

Set WGRC_TESTNET_RESERVE_ADDRESS to the public Testnet bridge reserve.
The client uses gridcoinresearchd -testnet with the user's wallet configuration.
GRC_CLI and GRC_CONF can select the executable and configuration file.
EOF
}

die() { printf '%s\n' "$*" >&2; exit 1; }
rpc() { "${cli[@]}" "$@"; }

decimal_le() {
  [[ ${#1} -lt ${#2} || ( ${#1} -eq ${#2} && ( $1 == "$2" || $1 < $2 ) ) ]]
}

base_units() {
  local whole fraction units
  [[ $1 =~ ^([0-9]+)(\.([0-9]{1,8}))?$ ]] || die 'Enter a GRC amount with up to eight decimal places.'
  whole=${BASH_REMATCH[1]}
  fraction=${BASH_REMATCH[3]}00000000
  units=$whole${fraction:0:8}
  units=${units#"${units%%[!0]*}"}
  [[ -n $units ]] && decimal_le "$units" "$max_u64" || die 'Enter a positive amount within the wGRC limit.'
  printf '%s' "$units"
}

recipient_hex() {
  local address=$1 prefix index digit carry byte
  local -a bytes=()
  [[ ${#address} -ge 32 && ${#address} -le 44 ]] || die 'Enter a valid Solana public key.'
  prefix=${address%%[!1]*}
  for ((index=0; index<${#address}; index++)); do
    digit=${alphabet%%"${address:index:1}"*}
    carry=${#digit}
    (( carry < 58 )) || die 'Enter a valid Solana public key.'
    for byte in "${!bytes[@]}"; do
      carry=$((bytes[byte] * 58 + carry))
      bytes[byte]=$((carry & 255))
      carry=$((carry >> 8))
    done
    while (( carry > 0 )); do
      bytes+=( "$((carry & 255))" )
      carry=$((carry >> 8))
    done
  done
  [[ $((${#prefix} + ${#bytes[@]})) -eq 32 ]] || die 'Enter a valid Solana public key.'
  for ((index=0; index<${#prefix}; index++)); do printf '00'; done
  for ((index=${#bytes[@]}-1; index>=0; index--)); do printf '%02x' "${bytes[index]}"; done
}

reverse_bytes() {
  local input=$1 index
  for ((index=${#input}-2; index>=0; index-=2)); do printf '%s' "${input:index:2}"; done
}

read_u64() {
  local hex
  hex=$(reverse_bytes "$1")
  printf '%u' "$((16#$hex))"
}

# Read a serialized Gridcoin transaction using byte offsets. Gridcoin places
# a four-byte timestamp between the version and the CompactSize input count.
take_hex() {
  (( offset + $1 * 2 <= ${#raw} )) || die 'Truncated Gridcoin transaction.'
  field=${raw:offset:$1*2}
  offset=$((offset + $1 * 2))
}

take_count() {
  local size
  take_hex 1
  count=$((16#$field))
  case $count in
    253) size=2 ;;
    254) size=4 ;;
    255) die 'Unsupported CompactSize in Gridcoin transaction.' ;;
    *) return ;;
  esac
  take_hex "$size"
  field=$(reverse_bytes "$field")
  count=$((16#$field))
}

inspect_outputs() {
  local raw=${1,,} offset=0 field count inputs outputs index script value previous
  local payments=0 carriers=0
  [[ $raw =~ ^([0-9a-f]{2})+$ ]] || die 'Invalid Gridcoin transaction hex.'
  take_hex 8
  take_count
  inputs=$count
  if [[ $2 == template ]]; then
    (( inputs == 0 )) || die 'Expected an unfunded Gridcoin transaction template.'
  else
    (( inputs > 0 )) || die 'Expected a signed Gridcoin transaction with inputs.'
  fi
  for ((index=0; index<inputs; index++)); do
    take_hex 36
    [[ $field != 0000000000000000000000000000000000000000000000000000000000000000ffffffff ]] ||
      die 'Coinbase inputs cannot fund a deposit.'
    take_count
    take_hex "$((count + 4))"
  done
  take_count
  outputs=$count
  carrier_offset=
  for ((index=0; index<outputs; index++)); do
    previous=$offset
    take_hex 8
    value=$field
    take_count
    take_hex "$count"
    script=$field
    [[ -n $script || $index != 0 ]] || die 'Unexpected empty first output script.'
    if [[ $script == "$reserve_script" ]]; then
      [[ $(read_u64 "$value") == "$amount" ]] || die 'Reserve output amount differs from the deposit.'
      payment_index=$index
      payments=$((payments + 1))
    elif [[ $script == 6a* ]]; then
      [[ $script == "$carrier_script" ]] || die 'Unexpected Gridcoin deposit payload.'
      if [[ $2 == template ]]; then
        [[ $value == 0000000000000000 ]] || die 'Expected a zero-value carrier template.'
        carrier_offset=$previous
      else
        [[ $value == 0100000000000000 ]] || die 'Expected a one-base-unit deposit carrier.'
      fi
      carriers=$((carriers + 1))
    fi
  done
  (( payments == 1 && carriers == 1 )) || die 'Expected one reserve payment and one OP_RETURN output.'
  if [[ $2 == template ]]; then
    (( outputs == 2 )) || die 'Expected two outputs in the unfunded deposit template.'
    patched=${raw:0:carrier_offset}0100000000000000${raw:carrier_offset+16}
  fi
}

check_capacity() {
  local response bridge limit mint maximum supply remaining
  local -a accounts
  local program=AvqkRykFXfx31fDYnJq7kPkNpgiMA6LbknavHMvjz3Zy
  local request='{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["8h6GqMyR1vLxm3jHqKzF7wR1Ar4vcD4abVwMavG3XKRc","Ftv6aUb4TZjKPHigG6KLUj4tohP8gFTLhLKDqRVrsJkA","4cwiLPuXXsYqsWJCWi31HYSJVWpGMj7YySxAj3HTgF8S"],{"encoding":"base64","commitment":"finalized"}]}'
  response=$(curl -fsS --max-time 30 -H 'Content-Type: application/json' --data "$request" https://api.devnet.solana.com) ||
    die 'Could not check the public Solana Devnet supply cap.'
  jq -e --arg program "$program" '
    (.result.value | length) == 3 and .result.value[0].owner == $program
    and .result.value[1].owner == $program
    and .result.value[2].owner == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    and all(.result.value[]; .data[1] == "base64" and (.data[0] | type) == "string")
  ' <<< "$response" >/dev/null || die 'The Devnet bridge supply cap could not be verified.'
  mapfile -t accounts < <(jq -r '.result.value[].data[0]' <<< "$response")
  bridge=$(printf '%s' "${accounts[0]}" | base64 -d | xxd -p -c 256)
  limit=$(printf '%s' "${accounts[1]}" | base64 -d | xxd -p -c 256)
  mint=$(printf '%s' "${accounts[2]}" | base64 -d | xxd -p -c 256)
  [[ $bridge == e7e81f626e03173b* && ${#bridge} -eq 146 && $limit == 63c15725ce862efa* &&
    ${#limit} -eq 32 && ${#mint} -eq 164 && ${mint:88:4} == 0801 ]] ||
    die 'Unexpected Devnet bridge account layout.'
  [[ ${bridge:144:2} == 00 ]] || die 'The bridge is paused.'
  maximum=$(read_u64 "${limit:16:16}")
  supply=$(read_u64 "${mint:72:16}")
  decimal_le "$supply" "$maximum" || die 'The bridge mint supply exceeds the configured cap.'
  # Bash arithmetic wraps at 64 bits. Print the resulting bit pattern as unsigned.
  printf -v remaining '%u' "$((maximum - supply))"
  decimal_le "$amount" "$remaining" || die 'Deposit would exceed the configured wGRC supply cap.'
}

deposit_record() {
  local decoded index_le digest
  decoded=$(rpc decoderawtransaction "$signed") || die 'Gridcoin could not decode the signed transaction.'
  txid=$(jq -er '.txid | select(test("^[a-f0-9]{64}$"))' <<< "$decoded") || die 'Invalid signed transaction ID.'
  inspect_outputs "$signed" signed
  printf -v index_le '%08x' "$payment_index"
  index_le=$(reverse_bytes "$index_le")
  digest=$(
    { printf 'WGRC-DEPOSIT-V1\0'; printf '%s' "$genesis$txid$index_le" | xxd -r -p; } |
      openssl dgst -sha256 -binary | xxd -p -c 32
  )
  record=$(jq -n --arg txid "$txid" --argjson vout "$payment_index" --arg depositId "$digest" \
    --arg recipient "$recipient" --arg amountBaseUnits "$amount" \
    '{ $txid, $vout, $depositId, $recipient, $amountBaseUnits }')
}

print_result() {
  jq --arg depositFile "$file" '. + {$depositFile}' <<< "$record"
}

if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then usage; exit 0; fi
if [[ $# -eq 2 && $1 == retry ]]; then
  retry=true
  file=$2
elif [[ $# -eq 3 && $2 == --solana-address ]]; then
  retry=false
  amount=$(base_units "$1")
  recipient=$3
else
  usage >&2
  exit 1
fi
for binary in "${cli[0]}" jq curl base64 xxd openssl; do
  command -v "$binary" >/dev/null || die "Required executable missing: $binary"
done
[[ -n $reserve ]] || die 'Set WGRC_TESTNET_RESERVE_ADDRESS to the public Testnet bridge reserve.'
if $retry; then
  saved=$(cat -- "$file") || die 'Could not read the saved deposit.'
  signed=$(jq -er '.signedHex | select(test("^([0-9a-fA-F]{2})+$"))' <<< "$saved") || die 'Invalid saved signed transaction.'
  recipient=$(jq -er '.recipient | strings' <<< "$saved") || die 'Missing saved Solana recipient.'
  amount=$(jq -er '.amountBaseUnits | strings | select(test("^[1-9][0-9]{0,19}$"))' <<< "$saved") ||
    die 'Invalid saved deposit amount.'
  decimal_le "$amount" "$max_u64" || die 'Invalid saved deposit amount.'
fi
key_hex=$(recipient_hex "$recipient")
payload=5747524301$key_hex
carrier_script=6a25$payload

[[ $(rpc getblockhash 0) == "$genesis" ]] || die 'Gridcoin Testnet required.'
address=$(rpc validateaddress "$reserve" | jq -er 'select(.isvalid == true) | .address | strings') ||
  die 'Expected a valid Gridcoin Testnet reserve address.'
outputs=$(jq -nc --arg address "$address" '{($address): "1"}')
template=$(rpc createrawtransaction '[]' "$outputs")
reserve_script=$(rpc decoderawtransaction "$template" | jq -er '.vout[0].scriptPubKey.hex')
[[ $reserve_script =~ ^(76a914[0-9a-f]{40}88ac|a914[0-9a-f]{40}87)$ ]] ||
  die 'Expected a Gridcoin Testnet P2PKH or P2SH reserve script.'

if $retry; then
  deposit_record
  jq -e --argjson record "$record" 'del(.signedHex) == $record' <<< "$saved" >/dev/null ||
    die 'The saved metadata does not match the signed transaction.'
  if lookup=$(rpc getrawtransaction "$txid" 1 2>&1); then
    jq -e --arg txid "$txid" '.txid == $txid' <<< "$lookup" >/dev/null ||
      die 'Gridcoin returned a different transaction.'
    if jq -e '(.confirmations | type == "number" and . > 0) or
      (.blockhash == null and (.confirmations // 0) == 0)' <<< "$lookup" >/dev/null; then
      print_result
      exit 0
    fi
  elif [[ ! $lookup =~ error[[:space:]]code:[[:space:]]-5([^0-9]|$) ]]; then
    die "Could not check the saved transaction: $lookup"
  fi
  check_capacity
else
  check_capacity
  fraction=00000000$amount
  fraction=${fraction: -8}
  if (( ${#amount} > 8 )); then whole=${amount:0:${#amount}-8}; else whole=0; fi
  outputs=$(jq -nc --arg address "$address" --arg value "$whole.$fraction" --arg data "$payload" \
    '{($address): $value, $data}')
  template=$(rpc createrawtransaction '[]' "$outputs")
  inspect_outputs "$template" template
  funded=$(rpc fundrawtransaction "$patched" | jq -er '.hex')
  signed=$(rpc signrawtransaction "$funded" | jq -er 'select(.complete == true) | .hex') ||
    die 'Gridcoin wallet could not fully sign the transaction.'
  deposit_record
  mkdir -p -- deposits
  file=$PWD/deposits/$txid.json
  (set -o noclobber; jq --arg signedHex "$signed" '. + {$signedHex}' <<< "$record" > "$file") ||
    die "Could not save the signed transaction at $file. Nothing was broadcast."
  printf 'Saved deposit transaction: %s\n' "$file" >&2
  check_capacity
fi

printf 'Broadcasting Gridcoin Testnet transaction %s\n' "$txid" >&2
if ! submitted=$(rpc sendrawtransaction "$signed") || [[ $submitted != "$txid" ]]; then
  printf 'Broadcast outcome is uncertain. Retry the same transaction with:\n  bash %q retry %q\n' "$0" "$file" >&2
  exit 1
fi
print_result
