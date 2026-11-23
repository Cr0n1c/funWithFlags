"""Fictional IMDSv1 directory tree. Never reads the host or contacts metadata."""
import json

ROLE = "ctf-instance-role"
VERSIONS = ("1.0", "2021-07-15", "latest")
METADATA = {
    "ami-id": "ami-0123456789abcdef0",
    "hostname": "ip-10-0-0-42.ec2.internal",
    "instance-id": "i-0123456789abcdef0",
    "instance-type": "t3.micro",
    "local-hostname": "ip-10-0-0-42.ec2.internal",
    "local-ipv4": "10.0.0.42",
    "public-hostname": "ctf-instance.example.invalid",
    "public-ipv4": "192.0.2.42",
    "security-groups": "ctf-training",
    "placement": "availability-zone\nregion\n",
    "placement/availability-zone": "us-east-1a",
    "placement/region": "us-east-1",
    "iam": "info\nsecurity-credentials/\n",
    "iam/info": json.dumps({
        "Code": "Success",
        "InstanceProfileArn": "arn:aws:iam::000000000000:instance-profile/ctf-training",
        "InstanceProfileId": "AIPAFICTIONALCTFPROFILE",
    }),
    "iam/security-credentials": ROLE + "\n",
}


def metadata_response(path: str, flag: str) -> str:
    path = path.strip("/")
    if not path:
        return "\n".join(VERSIONS) + "\n"
    version, _, resource = path.partition("/")
    if version not in VERSIONS:
        return "404 - Not Found\n"
    if not resource:
        return "dynamic/\nmeta-data/\nuser-data\n"
    if resource == "meta-data":
        return "\n".join(
            key + ("/" if key in ("iam", "placement") else "")
            for key in METADATA if "/" not in key
        ) + "\n"
    if resource == f"meta-data/iam/security-credentials/{ROLE}":
        # This is the sole flag location, replacing real temporary credentials.
        return json.dumps({"flag": flag})
    if resource.startswith("meta-data/"):
        return METADATA.get(resource[len("meta-data/"):], "404 - Not Found\n")
    if resource == "user-data":
        return "#cloud-config\n# Fictional CTF instance; no bootstrap secrets.\n"
    if resource == "dynamic":
        return "instance-identity/\n"
    if resource == "dynamic/instance-identity":
        return "document\n"
    if resource == "dynamic/instance-identity/document":
        return json.dumps({
            "accountId": "000000000000", "instanceId": METADATA["instance-id"],
            "instanceType": METADATA["instance-type"], "region": "us-east-1",
            "availabilityZone": "us-east-1a", "privateIp": "10.0.0.42",
            "imageId": METADATA["ami-id"], "architecture": "x86_64",
        })
    return "404 - Not Found\n"
