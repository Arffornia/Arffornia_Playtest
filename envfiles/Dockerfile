# pack-files: a small nginx that serves an Arffornia_Provisioning ref with the mod tag and
# the test profile applied (see njs/pack.js). Published as ghcr.io/arffornia/playtest-envfiles.
FROM nginx:1.27.4-alpine3.21@sha256:4ff102c5d78d254a6f0da062b3cf39eaf07f01eec0927fd21e219d0af8bc0591

ENV PACK_UPSTREAM=https://raw.githubusercontent.com/Arffornia/Arffornia_Provisioning \
    PROVISIONING_REF=refs/heads/main \
    MOD_TAG=edge \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

COPY nginx.conf /etc/nginx/nginx.conf
COPY templates/ /etc/nginx/templates/
COPY njs/ /etc/nginx/njs/
COPY profile.example.json /etc/pack-files/profile.json

# Unprivileged: the envsubst step writes conf.d, nginx writes only under /tmp.
RUN rm -f /etc/nginx/conf.d/default.conf \
    && chown -R nginx:nginx /etc/nginx/conf.d

USER 101
EXPOSE 8080
