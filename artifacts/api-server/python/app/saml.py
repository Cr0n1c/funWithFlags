"""Strict SAML toolkit adapter. Never expose toolkit diagnostics or raw assertions."""
from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any
from urllib.parse import urlsplit

from cryptography import x509
from onelogin.saml2.auth import OneLogin_Saml2_Auth
from onelogin.saml2.constants import OneLogin_Saml2_Constants as C
from onelogin.saml2.settings import OneLogin_Saml2_Settings
from onelogin.saml2.xml_utils import OneLogin_Saml2_XML

from app.config import Settings, public_https_origin

ATTRIBUTES = {
    "email": 320, "first_name": 128, "last_name": 128,
    "department_parent": 255, "department_leaf": 255, "level": 128,
}
ATTRIBUTE_SOURCES = {
    "email": "email",
    "first_name": "firstname",
    "last_name": "lastname",
    "department_parent": "departmentparent",
    "department_leaf": "departmentleaf",
    "level": "level",
}


class SamlError(Exception):
    """Safe generic failure."""


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def subject_key(issuer: str, subject: str) -> str:
    return "saml:" + digest(json.dumps([issuer, subject], separators=(",", ":")))


def toolkit_settings(s: Settings) -> dict:
    if not all([s.saml_idp_entity_id, s.saml_idp_sso_url,
                s.saml_idp_cert.get_secret_value(), s.saml_sp_entity_id, s.saml_acs_url]):
        raise SamlError("Okta SAML is not configured. Contact the administrator.")
    try:
        acs = urlsplit(s.saml_acs_url)
        origin = urlsplit(s.app_base_url)
        sso = urlsplit(s.saml_idp_sso_url)
        # Parse all active certificates before login or metadata can succeed.
        for cert in (s.saml_idp_cert, s.saml_idp_rollover_cert):
            if cert.get_secret_value():
                x509.load_pem_x509_certificate(cert.get_secret_value().encode())
        valid_sso = bool(sso.hostname and sso.port != 0)
    except (ValueError, TypeError):
        raise SamlError("Okta SAML configuration is invalid.") from None
    if (not public_https_origin(s.app_base_url, production=s.is_production)
            or acs.scheme != "https" or acs.netloc != origin.netloc
            or acs.path != "/api/auth/saml/acs" or acs.query or acs.fragment
            or acs.username or sso.scheme != "https" or not valid_sso
            or sso.username or sso.fragment):
        raise SamlError("Okta SAML configuration is invalid.")
    if not set(s.saml_required_attributes).issubset(ATTRIBUTES):
        raise SamlError("Okta SAML attribute configuration is invalid.")
    signing_key = s.saml_sp_private_key.get_secret_value()
    signing_cert = s.saml_sp_cert.get_secret_value()
    if bool(signing_key) != bool(signing_cert):
        raise SamlError("Both SP signing key and certificate must be configured.")
    result: dict[str, Any] = {
        "strict": True, "debug": False,
        "sp": {
            "entityId": s.saml_sp_entity_id,
            "assertionConsumerService": {"url": s.saml_acs_url, "binding": C.BINDING_HTTP_POST},
            "NameIDFormat": C.NAMEID_PERSISTENT,
            "x509cert": signing_cert, "privateKey": signing_key,
        },
        "idp": {
            "entityId": s.saml_idp_entity_id,
            "singleSignOnService": {"url": s.saml_idp_sso_url, "binding": C.BINDING_HTTP_REDIRECT},
            "x509cert": s.saml_idp_cert.get_secret_value(),
        },
        "security": {
            "wantAssertionsSigned": True, "wantMessagesSigned": True,
            "wantNameId": True, "wantXMLValidation": True,
            "rejectUnsolicitedResponsesWithInResponseTo": True,
            "requestedAuthnContext": False,
            "rejectDeprecatedAlgorithm": True,
            "authnRequestsSigned": bool(signing_key),
            "signatureAlgorithm": C.RSA_SHA256, "digestAlgorithm": C.SHA256,
        },
    }
    rollover = s.saml_idp_rollover_cert.get_secret_value()
    if rollover:
        idp: Any = result["idp"]
        idp["x509certMulti"] = {
            "signing": [s.saml_idp_cert.get_secret_value(), rollover],
        }
    return result


def auth(s: Settings, post: dict | None = None) -> OneLogin_Saml2_Auth:
    config = toolkit_settings(s)
    acs = urlsplit(s.saml_acs_url)
    try:
        return OneLogin_Saml2_Auth({
            "https": "on", "http_host": acs.netloc,
            "script_name": acs.path, "get_data": {}, "post_data": post or {},
        }, config)
    except Exception:
        raise SamlError("Okta SAML configuration is invalid.") from None


def metadata(s: Settings) -> str:
    try:
        settings = OneLogin_Saml2_Settings(toolkit_settings(s))
        xml = settings.get_sp_metadata()
        if settings.validate_metadata(xml):
            raise SamlError("Okta SAML metadata is invalid.")
        return xml
    except SamlError:
        raise
    except Exception:
        raise SamlError("Okta SAML configuration is invalid.") from None


def validated_groups(groups: Any) -> list[str]:
    """Bound display-only memberships; never use these claims as role inputs."""
    if (not isinstance(groups, list) or len(groups) > 200
            or any(not isinstance(group, str) or len(group) > 255
                   or any(unicodedata.category(char).startswith("C") for char in group)
                   for group in groups)):
        raise SamlError("Okta SAML group attributes are invalid.")
    return sorted({group.strip() for group in groups if group.strip()})


def validate(  # noqa: PLR0912 - explicit fail-closed validation gates
    s: Settings, encoded: str, request_id: str,
) -> tuple[str, str, dict]:
    try:
        client = auth(s, {"SAMLResponse": encoded})
        client.process_response(request_id=request_id)
        if client.get_errors() or not client.is_authenticated():
            raise SamlError("Okta SAML response failed validation.")
        if client.get_last_response_in_response_to() != request_id:
            raise SamlError("Okta SAML request correlation failed.")
        # Toolkit validates cryptographic signatures first. Strengthen its URL
        # prefix/substring matching to exact SP endpoint binding, and require
        # audience and bounded validity rather than accepting absent values.
        document = OneLogin_Saml2_XML.to_etree(client.get_last_response_xml())
        ns = {"s": C.NS_SAML, "p": C.NS_SAMLP}
        assertions = document.xpath("./s:Assertion", namespaces=ns)
        if document.get("Destination") != s.saml_acs_url or len(assertions) != 1:
            raise SamlError("Okta SAML endpoint binding failed.")
        assertion = assertions[0]
        issuers = document.xpath("./s:Issuer/text()", namespaces=ns)
        assertion_issuers = assertion.xpath("./s:Issuer/text()", namespaces=ns)
        if issuers != [s.saml_idp_entity_id] or assertion_issuers != [s.saml_idp_entity_id]:
            raise SamlError("Okta SAML issuer validation failed.")
        conditions = assertion.xpath("./s:Conditions", namespaces=ns)
        restrictions = assertion.xpath(
            "./s:Conditions/s:AudienceRestriction", namespaces=ns,
        )
        if (len(conditions) != 1 or not conditions[0].get("NotBefore")
                or not conditions[0].get("NotOnOrAfter") or not restrictions
                or any(s.saml_sp_entity_id not in restriction.xpath(
                    "./s:Audience/text()", namespaces=ns,
                ) for restriction in restrictions)):
            raise SamlError("Okta SAML audience or validity is missing.")
        confirmations = assertion.xpath(
            "./s:Subject/s:SubjectConfirmation/s:SubjectConfirmationData", namespaces=ns,
        )
        if len(confirmations) != 1 or not all(
            node.get("Recipient") == s.saml_acs_url
            and node.get("InResponseTo") == request_id and node.get("NotOnOrAfter")
            for node in confirmations
        ):
            raise SamlError("Okta SAML subject confirmation failed.")
        subject = client.get_nameid()
        # The toolkit checks SPNameQualifier, but not the IdP NameQualifier.
        # Do not collapse differently scoped persistent IDs into one account.
        if client.get_nameid_nq() not in (None, s.saml_idp_entity_id):
            raise SamlError("Okta SAML identity qualifier is invalid.")
        assertion_id = client.get_last_assertion_id()
        if (not subject or len(subject) > 255 or not assertion_id
                or len(assertion_id) > 255
                or client.get_nameid_format() != C.NAMEID_PERSISTENT):
            raise SamlError("Okta SAML stable identity is missing or invalid.")
        attrs = client.get_attributes()
        profile = {}
        for name, limit in ATTRIBUTES.items():
            values = attrs.get(ATTRIBUTE_SOURCES[name], [])
            if not isinstance(values, list) or len(values) > 1:
                raise SamlError("Okta SAML profile attributes are invalid.")
            value = values[0] if values else None
            if value is not None:
                if (not isinstance(value, str) or len(value) > limit
                        or any(ord(c) < 32 for c in value)):
                    raise SamlError("Okta SAML profile attributes are invalid.")
                value = value.strip() or None
            if name in s.saml_required_attributes and value is None:
                raise SamlError("Okta SAML required profile attributes are missing.")
            profile[name] = value
        # Display-only claims from the validated assertion, never role inputs.
        profile["groups"] = validated_groups(attrs.get("groups", []))
        return subject, assertion_id, profile
    except SamlError:
        raise
    except Exception:
        raise SamlError("Okta SAML response failed validation.") from None