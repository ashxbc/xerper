#!/bin/sh
npm run dev > /tmp/devserver.log 2>&1 &
SERVER_PID=$!

i=0
while [ $i -lt 30 ]; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
  if [ "$CODE" = "200" ]; then
    break
  fi
  i=$((i+1))
  sleep 1
done

echo "--- response ---"
curl -s -X POST http://localhost:3000/api/impressions \
  -H "Content-Type: application/json" \
  -d '{"username":"valor0x","project":"caldera"}'
echo
echo "--- devserver log tail ---"
tail -n 60 /tmp/devserver.log

kill $SERVER_PID 2>/dev/null
wait 2>/dev/null
