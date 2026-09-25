#!/bin/bash
# Single 10k run via HAProxy :8088 — run on .46 only. Requires sshpass + mpstat.
MODE=$1
: "${SSH_PASS_68:?Set SSH_PASS_68}"
PASS68="$SSH_PASS_68"
OUT=/tmp/bench_alltypes_${MODE}.txt
MON=/tmp/bench_alltypes_${MODE}_mon.csv
MON68=/tmp/bench_alltypes_${MODE}_mon68.csv
KONG46=supabase-kong-kar0ro1k6jiyfxzzw7acnsza
echo "$MODE" > /tmp/bench_mode.txt
L46B=$(docker logs "$KONG46" 2>&1 | wc -l)
L68B=$(sshpass -p "$PASS68" ssh -o StrictHostKeyChecking=no mithil@192.168.23.68 \
  "echo $PASS68 | sudo -S docker logs supabase-kong-ypwzkftxvvbjfvsll1y3aesk 2>&1 | wc -l" 2>/dev/null || echo 0)
{
  echo "mode=$MODE n=10000 all_types_mixed start=$(date -Is)"
  echo "kong46_before=$L46B kong68_before=$L68B"
  echo "before46=$(uptime)"
} > "$OUT"
sshpass -p "$PASS68" ssh -o StrictHostKeyChecking=no mithil@192.168.23.68 "uptime" >> "$OUT" 2>/dev/null || true
echo ts,load1,load15,idle,mem > "$MON"
echo ts,load1,idle,mem > "$MON68"
echo 1 > /tmp/balltypes
(
  while [ -f /tmp/balltypes ]; do
    read l1 l5 l15 _ < /proc/loadavg
    idle=$(mpstat 1 1 2>/dev/null | awk '/Average/ {print $NF}')
    mem=$(free -m | awk '/Mem:/ {print $3}')
    echo "$(date +%s),$l1,$l15,$idle,$mem" >> "$MON"
    sleep 2
  done
) &
MP=$!
sshpass -p "$PASS68" ssh -o StrictHostKeyChecking=no mithil@192.168.23.68 \
  "echo 1 > /tmp/balltypes68; while [ -f /tmp/balltypes68 ]; do read l1 x x x x < /proc/loadavg; idle=\$(mpstat 1 1 2>/dev/null | awk '/Average/ {print \$NF}'); mem=\$(free -m | awk '/Mem:/ {print \$3}'); echo \$(date +%s),\$l1,\$idle,\$mem; sleep 2; done" \
  >> "$MON68" 2>/dev/null &
M68=$!
python3 /tmp/bench_alltypes_8088.py >> "$OUT" 2>&1
rm -f /tmp/balltypes
sshpass -p "$PASS68" ssh -o StrictHostKeyChecking=no mithil@192.168.23.68 "rm -f /tmp/balltypes68" 2>/dev/null || true
wait $MP 2>/dev/null || true
wait $M68 2>/dev/null || true
L46A=$(docker logs "$KONG46" 2>&1 | wc -l)
L68A=$(sshpass -p "$PASS68" ssh -o StrictHostKeyChecking=no mithil@192.168.23.68 \
  "echo $PASS68 | sudo -S docker logs supabase-kong-ypwzkftxvvbjfvsll1y3aesk 2>&1 | wc -l" 2>/dev/null || echo 0)
{
  echo "kong46_delta=$((L46A - L46B)) kong68_delta=$((L68A - L68B))"
  echo "after46=$(uptime)"
  free -m
  awk -F, 'NR>1{if($2+0>a)a=$2+0; if($4+0<b||NR==2)b=$4+0; if($5+0>c)c=$5+0} END{print "peak_load1_46="a,"min_idle_pct_46="b,"peak_mem_mb_46="c}' "$MON"
  awk -F, 'NR>1{if($2+0>a)a=$2+0; if($3+0<b||NR==2)b=$3+0; if($4+0>c)c=$4+0} END{print "peak_load1_68="a,"min_idle_pct_68="b,"peak_mem_mb_68="c}' "$MON68"
  echo "end=$(date -Is)"
} >> "$OUT"
cat "$OUT"
