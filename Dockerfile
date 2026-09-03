FROM searxng/searxng:latest

COPY searxng/settings.yml /etc/searxng/settings.yml

ENV SEARXNG_BASE_URL=http://localhost:8080/
