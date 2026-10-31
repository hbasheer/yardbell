use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::net::IpAddr;

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xffc0) == 0xfe80
                || (first & 0xfe00) == 0xfc00
        }
    }
}

// Checked when the name resolves rather than before, so a name that later changes to a private
// address is refused on that very request.
pub struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let found: Vec<_> = tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if found.iter().any(|a| is_private(a.ip())) {
                let refused = format!("{} is a private address", name.as_str());
                return Err(refused.into());
            }
            Ok(Box::new(found.into_iter()) as Addrs)
        })
    }
}
