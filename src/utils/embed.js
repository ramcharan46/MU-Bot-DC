function createEmbedUtils(MessageEmbed, defaultColor) {
  function makeEmbed(title, description, color = defaultColor, fields = []) {
    const embed = new MessageEmbed().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    if (fields.length) embed.addFields(fields);
    return embed;
  }

  function setEmbedAuthorSafe(embed, name, iconURL) {
    if (!embed || typeof embed.setAuthor !== "function") return embed;
    try {
      embed.setAuthor({ name, iconURL });
    } catch (_) {
      try {
        embed.setAuthor(name, iconURL);
      } catch (_) {
        // ignore unsupported signatures
      }
    }
    return embed;
  }

  function setEmbedFooterSafe(embed, text) {
    if (!embed || typeof embed.setFooter !== "function") return embed;
    try {
      embed.setFooter({ text });
    } catch (_) {
      try {
        embed.setFooter(text);
      } catch (_) {
        // ignore unsupported signatures
      }
    }
    return embed;
  }

  function setEmbedThumbnailSafe(embed, url) {
    if (!embed || typeof embed.setThumbnail !== "function" || !url) return embed;
    try {
      embed.setThumbnail(url);
    } catch (_) {
      // ignore invalid thumbnail url
    }
    return embed;
  }

  return {
    makeEmbed,
    setEmbedAuthorSafe,
    setEmbedFooterSafe,
    setEmbedThumbnailSafe,
  };
}

module.exports = {
  createEmbedUtils,
};
