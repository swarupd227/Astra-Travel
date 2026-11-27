# The sign-in server for environments without Microsoft Entra ID (development only). Build from this folder:
#   docker build -t astra-keycloak infra/azure/keycloak
# The realm file holds no secrets: they come from the environment when it is imported on first start.
FROM quay.io/keycloak/keycloak:26.4 AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_CACHE=local
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.4
COPY --from=build /opt/keycloak/ /opt/keycloak/
COPY realm-astra.json /opt/keycloak/data/import/realm-astra.json
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
