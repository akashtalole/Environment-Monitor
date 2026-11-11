# Extra intermediate certificates

Some `*.nic.in` servers (environmentclearance, forestsclearance, cpc.parivesh, cpcb) send their
own certificate but not the intermediate CA certificate that links it to a trusted root.
Browsers fetch the missing piece automatically; Node.js does not, so requests fail with
`unable to verify the first certificate`.

The monitor never turns certificate checks off. Instead, add the missing intermediate:

1. Open the site in a browser → padlock → certificate → **Details**. Find the issuer
   certificate (the one directly above the site's certificate) and export it as PEM
   (Base64). Or download it from the "CA Issuers" URL listed in the site certificate's
   *Authority Information Access* field and convert it:
   `openssl x509 -inform der -in issuer.crt -out certs/nic-intermediate.pem`
2. Save it here, e.g. `certs/nic-intermediate.pem`.
3. In `config/sources.json`, add `"caFile": "certs/nic-intermediate.pem"` to that source.

The file is added on top of Node's normal trusted roots, so the full chain is still verified.
