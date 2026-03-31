FROM heroiclabs/nakama:3.21.1

COPY ./backend/modules/build/index.js /nakama/data/modules/build/index.js
COPY ./backend/config/config.prod.yml /nakama/data/config.yml