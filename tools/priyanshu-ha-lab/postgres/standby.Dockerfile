FROM postgres:15-alpine
COPY standby-entrypoint.sh /standby-entrypoint.sh
RUN chmod +x /standby-entrypoint.sh
USER root
ENTRYPOINT ["/standby-entrypoint.sh"]
